/**
 * The tenants surface — HIVE-5.1 (#5304).
 *
 * `/ade/dashboard/tenants`: the workspace list, and the drawer an administrator manages one
 * from. The page composes these; the logic they share is in {@link ./tenantsModel}, which is
 * pure and unit-tested so that a member filter can never again be state two tenants share.
 */

export { default as TenantsTable } from './TenantsTable';
export type { TenantsTableProps } from './TenantsTable';

export { default as TenantManageDrawer } from './TenantManageDrawer';
export type { TenantManageDrawerProps } from './TenantManageDrawer';

export { default as TenantMembersSection } from './TenantMembersSection';
export type { TenantMembersSectionProps } from './TenantMembersSection';

export { default as TenantMcpKeysSection } from './TenantMcpKeysSection';
export type { TenantMcpKeysSectionProps } from './TenantMcpKeysSection';

export { default as EditTenantDialog, SlugChangeConfirmDialog } from './EditTenantDialog';
export type {
  EditTenantDialogProps,
  SlugChangeConfirmDialogProps,
} from './EditTenantDialog';

export {
  AddMemberDialog,
  EditMemberRolesDialog,
  RemoveMemberDialog,
} from './TenantMemberDialogs';
export type {
  AddMemberDialogProps,
  EditMemberRolesDialogProps,
  RemoveMemberDialogProps,
} from './TenantMemberDialogs';

export * from './tenantsModel';
