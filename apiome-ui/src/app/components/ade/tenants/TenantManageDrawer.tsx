'use client';

import * as React from 'react';
import {
  BadgeCheck,
  Check,
  History,
  KeyRound,
  Lock,
  Network,
  Pencil,
  Users,
} from 'lucide-react';

import { Avatar } from '@/app/components/ui/Avatar';
import { Badge } from '@/app/components/ui/Badge';
import { Button } from '@/app/components/ui/Button';
import {
  Drawer,
  DrawerBody,
  DrawerContent,
  DrawerDescription,
  DrawerFooter,
  DrawerHeader,
  DrawerOpenFullPageLink,
  DrawerTitle,
} from '@/app/components/ui/Drawer';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/app/components/ui/Tabs';

import TenantLicensePanel from '@/app/ade/dashboard/tenants/TenantLicensePanel';
import TenantMcpPolicyHistory from '@/app/ade/dashboard/tenants/TenantMcpPolicyHistory';
import TenantMcpSettingsPanel from '@/app/ade/dashboard/tenants/TenantMcpSettingsPanel';

import TenantMcpKeysSection from './TenantMcpKeysSection';
import TenantMembersSection from './TenantMembersSection';
import {
  TENANT_MANAGE_SECTIONS,
  TENANT_MANAGE_SECTION_LABELS,
  tenantSectionLockNote,
  tenantSectionNeedsCurrent,
  type TenantManageSection,
  type TenantMember,
  type TenantRow,
} from './tenantsModel';

/**
 * The tenant manage drawer — HIVE-5.1 (#5304).
 *
 * Authority: `docs/mockups/workspace/tenants.html` `#manage-drawer`; DESIGN.md §5.4
 * ("Drawer — right, 520/680/860 px") and §6 (progressive disclosure).
 *
 * ### What this replaces, and why the shape had to change
 *
 * Managing a tenant used to be a `hidden` `<div id={`tenant-${id}`}>` per administered
 * tenant, stacked below the table, un-hidden by a menu item that reached for the element and
 * called `classList.toggle('hidden')`. Three things followed from that and all three are
 * fixed by making the panel a drawer:
 *
 *  1. **React did not know it was open.** The open state lived in the DOM, so nothing could
 *     depend on it — not a focus trap, not `Esc`, not a scroll lock, not a re-render.
 *  2. **The panels were shared.** One `isMembersExpanded` and one `memberFilter` served
 *     every tenant's block at once, so filtering one tenant's members filtered them all.
 *     Here the sections are children of a drawer that is open for exactly one tenant, and
 *     each holds its own state — the isolation is structural.
 *  3. **Everything was open at once.** Three of the densest panels in the product stacked
 *     vertically below a table. They are now five vertical tabs, in the mockup's order.
 *
 * ### Why the panels stay mounted once visited
 *
 * `TabsContent` is `forceMount`ed, but its children are only created once their section has
 * been opened. So nothing loads until the reader asks for it — and once a section has
 * loaded, switching tabs does not throw away its state. That matters most for MCP settings,
 * whose draft would otherwise be discarded by a glance at Policy history; the unsaved dot on
 * the MCP tab exists precisely to point at a draft the reader has tabbed away from.
 *
 * ### Non-current tenants
 *
 * Four of the five sections read `/api/tenants/*`, a proxy with no tenant parameter — it is
 * always scoped to the session's current tenant. For any other tenant those sections show
 * the lock note from {@link tenantSectionLockNote} naming the tenant, rather than showing
 * the current tenant's figures under a different name. Members are unaffected: they come
 * from the tenant list the page has already loaded.
 */

/** Props for {@link TenantManageDrawer}. */
export interface TenantManageDrawerProps {
  /** The tenant being managed; `null` closes the drawer. */
  tenant: TenantRow | null;
  /** Called with `false` when the drawer is dismissed. */
  onOpenChange: (open: boolean) => void;
  /** This tenant's people, merged and unfiltered. */
  members: readonly TenantMember[];
  /** The viewer, so their own membership row can withhold its destructive actions. */
  currentUserId: string | null | undefined;
  /** True while the page is (re)loading the tenant lists. */
  loading?: boolean;
  /** Open the Edit tenant dialog for this tenant. */
  onEditTenant: (tenant: TenantRow) => void;
  onAddMember: () => void;
  onEditMember: (member: TenantMember) => void;
  onRemoveMember: (member: TenantMember) => void;
  /** Where "Open full page" and the members foot link go. */
  membersPageHref: string;
}

/** The icon each vertical tab carries. */
const SECTION_ICONS: Readonly<Record<TenantManageSection, React.ElementType>> = {
  members: Users,
  license: BadgeCheck,
  mcp: Network,
  keys: KeyRound,
  history: History,
};

/**
 * The manage drawer.
 *
 * @param props See {@link TenantManageDrawerProps}.
 * @returns The `xl` side sheet, or a closed drawer when no tenant is being managed.
 */
export default function TenantManageDrawer({
  tenant,
  onOpenChange,
  members,
  currentUserId,
  loading = false,
  onEditTenant,
  onAddMember,
  onEditMember,
  onRemoveMember,
  membersPageHref,
}: TenantManageDrawerProps) {
  const [section, setSection] = React.useState<TenantManageSection>('members');
  /** Sections the reader has opened — the panels that may mount. */
  const [visited, setVisited] = React.useState<ReadonlySet<TenantManageSection>>(
    () => new Set<TenantManageSection>(['members'])
  );
  /** True while MCP settings holds an unsaved draft, for the tab's dot. */
  const [mcpDirty, setMcpDirty] = React.useState(false);
  /**
   * Bumped when tenant policy is saved.
   *
   * The keys and history sections are siblings of MCP settings rather than its children now,
   * so a save has to reach them by a counter instead of by a prop drilled down one level.
   */
  const [policyRevision, setPolicyRevision] = React.useState(0);

  const tenantId = tenant?.id ?? null;

  // A drawer opened for a different tenant is a different conversation: start it at Members
  // with nothing mounted but Members, and with no stale dirty flag from the last tenant.
  React.useEffect(() => {
    if (!tenantId) return;
    setSection('members');
    setVisited(new Set<TenantManageSection>(['members']));
    setMcpDirty(false);
    setPolicyRevision(0);
  }, [tenantId]);

  const handleSectionChange = React.useCallback((value: string) => {
    const next = value as TenantManageSection;
    setSection(next);
    setVisited((prev) => (prev.has(next) ? prev : new Set(prev).add(next)));
  }, []);

  const handlePolicySaved = React.useCallback(() => {
    setPolicyRevision((revision) => revision + 1);
  }, []);

  if (!tenant) {
    return <Drawer open={false} onOpenChange={onOpenChange} />;
  }

  const isCurrent = tenant.isCurrent;
  const memberCount = members.length;

  /**
   * A section's body, or the lock note that stands in for it.
   *
   * @param target The section being drawn.
   * @param body What it renders when the tenant is the current one.
   * @returns The body, or a {@link GatedState} naming the tenant.
   */
  const gated = (target: TenantManageSection, body: React.ReactNode) => {
    if (!tenantSectionNeedsCurrent(target) || isCurrent) return body;
    return (
      <p className="tnt-lock-note" data-testid={`tnt-lock-${target}`}>
        <Lock className="size-[var(--icon-dense)] shrink-0" aria-hidden />
        {tenantSectionLockNote(target, tenant.name)}
      </p>
    );
  };

  return (
    <Drawer open onOpenChange={onOpenChange}>
      <DrawerContent
        size="xl"
        data-testid="tenant-manage-drawer"
        data-tenant-id={tenant.id}
        aria-label={`Manage ${tenant.name}`}
      >
        <DrawerHeader className="flex-row items-start gap-3">
          <Avatar name={tenant.name} seed={tenant.id} size="lg" shape="hex" tone="brand" />
          <div className="min-w-0 grow">
            <DrawerTitle>Manage {tenant.name}</DrawerTitle>
            {/* `asChild`, so the sub-line is a `<div>`: it carries a `Badge`, which is a
                `<div>` too, and a `<div>` inside the `<p>` Radix would otherwise render is
                invalid HTML that React reports and browsers repair by splitting the
                paragraph — taking the description's own id with it. */}
            <DrawerDescription asChild>
              <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-fg-muted">
                <span className="font-mono">{tenant.slug}</span>
                <span aria-hidden>·</span>
                <span>
                  {memberCount} {memberCount === 1 ? 'member' : 'members'}
                </span>
                <span aria-hidden>·</span>
                <span>{tenant.isAdmin ? 'You administer this tenant' : 'Member'}</span>
                {isCurrent && (
                  <Badge variant="accent">
                    <Check aria-hidden />
                    Current
                  </Badge>
                )}
              </div>
            </DrawerDescription>
          </div>
          <Button
            variant="outline"
            size="sm"
            className="mt-0.5 shrink-0"
            onClick={() => onEditTenant(tenant)}
          >
            <Pencil aria-hidden />
            Edit tenant
          </Button>
        </DrawerHeader>

        <DrawerBody>
          <Tabs
            value={section}
            onValueChange={handleSectionChange}
            orientation="vertical"
            className="tnt-manage-grid"
          >
            <TabsList
              variant="vertical"
              aria-label="Administration sections"
              className="tnt-manage-nav"
            >
              {TENANT_MANAGE_SECTIONS.map((entry) => {
                const Icon = SECTION_ICONS[entry];
                return (
                  <TabsTrigger key={entry} value={entry} variant="vertical" size="sm">
                    <Icon aria-hidden />
                    <span className="truncate">{TENANT_MANAGE_SECTION_LABELS[entry]}</span>
                    {entry === 'members' && (
                      <span className="tnt-tab-count">{memberCount}</span>
                    )}
                    {entry === 'mcp' && mcpDirty && (
                      <span
                        className="tnt-tab-dot"
                        data-testid="tnt-mcp-unsaved-dot"
                        title="Unsaved changes"
                      >
                        <span className="sr-only">Unsaved changes</span>
                      </span>
                    )}
                  </TabsTrigger>
                );
              })}
            </TabsList>

            <div className="min-w-0">
              <TabsContent value="members" forceMount className="mt-0">
                {visited.has('members') && (
                  <TenantMembersSection
                    members={members}
                    tenantName={tenant.name}
                    currentUserId={currentUserId}
                    loading={loading}
                    onAddMember={onAddMember}
                    onEditMember={onEditMember}
                    onRemoveMember={onRemoveMember}
                    membersPageHref={membersPageHref}
                  />
                )}
              </TabsContent>

              <TabsContent value="license" forceMount className="mt-0">
                {visited.has('license') &&
                  gated(
                    'license',
                    <TenantLicensePanel isCurrentTenant={isCurrent} tenantName={tenant.name} />
                  )}
              </TabsContent>

              <TabsContent value="mcp" forceMount className="mt-0">
                {visited.has('mcp') &&
                  gated(
                    'mcp',
                    <TenantMcpSettingsPanel
                      isCurrentTenant={isCurrent}
                      isAdmin={tenant.isAdmin}
                      tenantName={tenant.name}
                      onDirtyChange={setMcpDirty}
                      onPolicySaved={handlePolicySaved}
                    />
                  )}
              </TabsContent>

              <TabsContent value="keys" forceMount className="mt-0">
                {visited.has('keys') &&
                  gated(
                    'keys',
                    <TenantMcpKeysSection
                      isAdmin={tenant.isAdmin}
                      policyRevision={policyRevision}
                    />
                  )}
              </TabsContent>

              <TabsContent value="history" forceMount className="mt-0">
                {visited.has('history') &&
                  gated('history', <TenantMcpPolicyHistory reloadToken={policyRevision} />)}
              </TabsContent>
            </div>
          </Tabs>
        </DrawerBody>

        <DrawerFooter>
          <span className="mr-auto text-xs text-fg-muted">
            Only administrators of {tenant.name} see this panel.
          </span>
          <DrawerOpenFullPageLink href={membersPageHref} className="mr-0">
            Open full page
          </DrawerOpenFullPageLink>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Done
          </Button>
        </DrawerFooter>
      </DrawerContent>
    </Drawer>
  );
}
