/**
 * The roles surface — HIVE-5.3 (#5306).
 *
 * `/ade/dashboard/roles`: who can view, create, edit, delete and publish, per resource, per
 * role. The page composes these; the logic they share is in {@link ./rolesModel}, which is
 * pure and unit-tested so that "is this draft dirty" and "may this role be renamed" are one
 * sentence each rather than one per surface, and the writes they make are in
 * {@link ./rolesApi}.
 */

export { default as RolesList } from './RolesList';
export type { RolesListProps } from './RolesList';

export { default as RoleEditor } from './RoleEditor';
export type { RoleEditorProps } from './RoleEditor';

export { default as PermissionMatrix } from './PermissionMatrix';
export type { PermissionMatrixProps } from './PermissionMatrix';

export {
  DeleteRoleDialog,
  DuplicateRoleDialog,
  NewRoleDialog,
  UnsavedChangesDialog,
} from './RoleDialogs';
export type {
  DeleteRoleDialogProps,
  DuplicateRoleDialogProps,
  NewRoleDialogProps,
  UnsavedChangesDialogProps,
} from './RoleDialogs';

export * from './rolesModel';
export * from './rolesApi';
