/**
 * The access plane's transport, and the two reads every access surface makes.
 *
 * `/api/access/*` forwards to apiome-rest `/v1/access/{tenantSlug}/*`, resolving the tenant
 * from the session server-side, and answers in a `{success, data | error, code?}` envelope.
 * Members (HIVE-5.2) unwrapped that envelope in a helper of its own; Roles (HIVE-5.3) makes
 * the same five calls against the same envelope, and a second copy of the unwrapping is a
 * second place for the stable machine `code` to be dropped. So it lives here, once, and the
 * two feature modules keep only the endpoints that are theirs.
 *
 * `GET roles` and `GET permissions/me` are here rather than in either feature module for the
 * same reason: the roles list and the viewer's own grants are what *both* screens gate
 * themselves on, and neither owns them.
 */

/** A role's permission grid is a set of these `resource`/`action` pairs. */
export interface RolePermissionCell {
  resource: string;
  action: string;
}

/** A role as `GET /api/access/roles` returns it. */
export interface RoleRecord {
  id: string;
  slug: string;
  name: string;
  description?: string | null;
  is_builtin: boolean;
  member_count?: number;
  permissions?: readonly RolePermissionCell[];
}

/** The viewer's own effective permissions, from `GET /api/access/permissions/me`. */
export interface MyPermissions {
  is_admin: boolean;
  permissions: readonly string[];
}

/** JSON request headers, stated once rather than at each write call site. */
export const JSON_HEADERS = { 'Content-Type': 'application/json' } as const;

/**
 * Call the access proxy and unwrap its envelope.
 *
 * @param path The path under `/api/access/`, already encoded.
 * @param init Fetch options; a JSON body must be stringified by the caller.
 * @returns The `data` payload, or `null` for a 204.
 * @throws Error whose message ends in `[code]` when the proxy reported a stable machine code
 *   (e.g. the OLO-5.3 `license-seats-exhausted` 403), so callers can run it through
 *   `describeLicenseError` for friendly upgrade guidance.
 */
export async function accessApi<T>(path: string, init?: RequestInit): Promise<T | null> {
  const res = await fetch(`/api/access/${path}`, init);
  if (res.status === 204) return null;
  const json = await res.json();
  if (!json.success) {
    const message = json.error || 'Request failed';
    const code = typeof json.code === 'string' ? json.code : undefined;
    throw new Error(code ? `${message} [${code}]` : message);
  }
  return json.data as T;
}

/**
 * Read the tenant's roles, with the permission grid each one grants.
 *
 * @returns Every role, built-in first, as the API orders them.
 */
export async function fetchRoles(): Promise<RoleRecord[]> {
  return (await accessApi<RoleRecord[]>('roles')) ?? [];
}

/**
 * Read the viewer's own effective permissions, which drive both screens' gates.
 *
 * @returns The `permissions/me` payload.
 */
export async function fetchMyPermissions(): Promise<MyPermissions | null> {
  return accessApi<MyPermissions>('permissions/me');
}
