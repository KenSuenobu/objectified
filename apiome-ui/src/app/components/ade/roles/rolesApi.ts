/**
 * The Roles screen's writes — HIVE-5.3 (#5306).
 *
 * The reads it makes are shared with Members and live in {@link ../access/accessApi}; the
 * four writes below are this screen's alone. Each is a named function rather than a `fetch`
 * written inline in the component, which is what lets the page keep one error path for all
 * of them and lets a test assert what actually reached the API.
 */

import { accessApi, JSON_HEADERS, type RoleRecord } from '../access/accessApi';
import type { RolePermissionCell } from '../access/accessApi';

/** The body `POST /roles` and `PUT /roles/{id}` both take. */
export interface RoleWrite {
  /** The role's name. Ignored by the server for a built-in role, whose name is immutable. */
  name: string;
  /** The description, or an empty string for none. */
  description: string;
  /** The complete grid — the server replaces, it does not merge. */
  permissions: readonly RolePermissionCell[];
}

/**
 * Create a custom role.
 *
 * @param body The name, description and initial grid. A grid copied from another role is
 *   just that role's cells passed here — there is no server-side "copy from".
 * @returns The created role, so the page can select it.
 */
export async function createRole(body: RoleWrite): Promise<RoleRecord | null> {
  return accessApi<RoleRecord>('roles', {
    method: 'POST',
    headers: JSON_HEADERS,
    body: JSON.stringify(body),
  });
}

/**
 * Replace a role's name, description and grid.
 *
 * @param roleId The role.
 * @param body The complete new state.
 */
export async function updateRole(roleId: string, body: RoleWrite): Promise<void> {
  await accessApi(`roles/${encodeURIComponent(roleId)}`, {
    method: 'PUT',
    headers: JSON_HEADERS,
    body: JSON.stringify(body),
  });
}

/**
 * Copy a role's grid into a new custom role.
 *
 * A server-side clone rather than a create with the cells attached: the source's description
 * comes along, and the copy is written in one request so a half-made role cannot be left
 * behind by a failure between two.
 *
 * @param roleId The role to copy.
 * @param name The copy's name.
 * @returns The created role.
 */
export async function duplicateRole(roleId: string, name: string): Promise<RoleRecord | null> {
  return accessApi<RoleRecord>(`roles/${encodeURIComponent(roleId)}/duplicate`, {
    method: 'POST',
    headers: JSON_HEADERS,
    body: JSON.stringify({ name }),
  });
}

/**
 * Delete a custom role.
 *
 * Its assignments cascade, so the members who held it keep their membership and lose the
 * permissions it granted. Built-in roles are refused by the server with a 400.
 *
 * @param roleId The role.
 */
export async function deleteRole(roleId: string): Promise<void> {
  await accessApi(`roles/${encodeURIComponent(roleId)}`, { method: 'DELETE' });
}
