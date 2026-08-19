/**
 * MCP catalog collections — types and pure helpers (V2-MCP-36.4 / MCAT-22.4, #4667).
 */

import { BROWSE_APP_URL } from '../../../../../../lib/app-urls';

/** One endpoint membership row in a curated collection. */
export interface McpCollectionMember {
  endpointId: string;
  position: number;
  name: string;
  slug: string;
  host: string;
  grade: string | null;
  visibility: string;
  published: boolean;
  addedAt: string;
}

/** One tenant-scoped curated collection. */
export interface McpCollection {
  id: string;
  name: string;
  slug: string;
  description: string | null;
  isPublished: boolean;
  memberCount: number;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
  members?: McpCollectionMember[];
}

function readString(obj: Record<string, unknown>, key: string): string | null {
  const value = obj[key];
  return typeof value === 'string' && value.trim() ? value : null;
}

/** Parse one collection member from the REST payload. */
export function mcpCollectionMemberFromPayload(raw: unknown): McpCollectionMember | null {
  if (!raw || typeof raw !== 'object') return null;
  const obj = raw as Record<string, unknown>;
  const endpointId = readString(obj, 'endpointId');
  const name = readString(obj, 'name');
  const slug = readString(obj, 'slug');
  if (!endpointId || !name || !slug) return null;
  return {
    endpointId,
    position: typeof obj.position === 'number' ? obj.position : 0,
    name,
    slug,
    host: readString(obj, 'host') ?? '',
    grade: readString(obj, 'grade'),
    visibility: readString(obj, 'visibility') ?? 'private',
    published: obj.published === true,
    addedAt: readString(obj, 'addedAt') ?? '',
  };
}

/** Parse one curated collection from the REST payload. */
export function mcpCollectionFromPayload(raw: unknown): McpCollection | null {
  if (!raw || typeof raw !== 'object') return null;
  const obj = raw as Record<string, unknown>;
  const id = readString(obj, 'id');
  const name = readString(obj, 'name');
  const slug = readString(obj, 'slug');
  const createdBy = readString(obj, 'createdBy');
  const createdAt = readString(obj, 'createdAt');
  const updatedAt = readString(obj, 'updatedAt');
  if (!id || !name || !slug || !createdBy || !createdAt || !updatedAt) return null;
  const membersRaw = obj.members;
  const members = Array.isArray(membersRaw)
    ? membersRaw
        .map((item) => mcpCollectionMemberFromPayload(item))
        .filter((item): item is McpCollectionMember => item !== null)
    : undefined;
  return {
    id,
    name,
    slug,
    description: readString(obj, 'description'),
    isPublished: obj.isPublished === true,
    memberCount: typeof obj.memberCount === 'number' ? obj.memberCount : members?.length ?? 0,
    createdBy,
    createdAt,
    updatedAt,
    members,
  };
}

/** Parse a collections list envelope. */
export function mcpCollectionsFromPayload(raw: unknown): McpCollection[] {
  if (!raw || typeof raw !== 'object') return [];
  const collections = (raw as Record<string, unknown>).collections;
  if (!Array.isArray(collections)) return [];
  return collections
    .map((item) => mcpCollectionFromPayload(item))
    .filter((item): item is McpCollection => item !== null);
}

/** Build a create-collection request body. */
export function mcpCollectionCreateBody(
  name: string,
  endpointIds: string[],
  options?: { description?: string; isPublished?: boolean; slug?: string },
): Record<string, unknown> {
  return {
    name: name.trim(),
    endpointIds,
    ...(options?.description?.trim() ? { description: options.description.trim() } : {}),
    ...(options?.isPublished ? { isPublished: true } : {}),
    ...(options?.slug?.trim() ? { slug: options.slug.trim() } : {}),
  };
}

/** Public share URL for a published collection on apiome-browse. */
export function mcpCollectionPublicUrl(tenantSlug: string, collectionSlug: string): string {
  const base = BROWSE_APP_URL.replace(/\/+$/, '');
  return `${base}/mcp/${encodeURIComponent(tenantSlug)}/collections/${encodeURIComponent(collectionSlug)}`;
}

/** The least an endpoint has to be for a collection to name it (HIVE-7.7, #5324). */
export interface McpCatalogEndpointRef {
  id: string;
  name: string;
}

/**
 * The endpoints visible in the current catalog slice, in the order the page draws them.
 *
 * This returned bare ids (`mcpVisibleEndpointIds`) while the create dialog only *counted* them.
 * HIVE-7.7 (#5324) needed their names too: the dialog now shows *which* endpoints are about to be
 * frozen into the collection, which is what makes "membership is fixed at creation" checkable
 * before pressing Create.
 *
 * @param groups The host groups currently on screen.
 * @returns One ref per visible endpoint.
 */
export function mcpVisibleEndpoints(
  groups: Array<{ endpoints: Array<McpCatalogEndpointRef> }>,
): McpCatalogEndpointRef[] {
  return groups.flatMap((group) => group.endpoints.map(({ id, name }) => ({ id, name })));
}

/** How many member names the create dialog spells before it summarises the rest. */
export const MCP_COLLECTION_HINT_NAMES = 5;

/**
 * The create dialog's membership sentence.
 *
 * Names up to {@link MCP_COLLECTION_HINT_NAMES} endpoints and counts the remainder, so a
 * collection built from a wide view still produces one readable line rather than forty names.
 *
 * @param endpoints The endpoints the collection would be created from.
 * @returns The sentence, including the "no endpoints" case — a collection may be created empty
 *   and filled from the endpoints' own pages, so this states the fact rather than blocking.
 */
export function mcpCollectionMembershipHint(
  endpoints: readonly McpCatalogEndpointRef[],
): string {
  if (endpoints.length === 0) {
    return 'The current catalog view has no endpoints, so this collection starts empty.';
  }
  const shown = endpoints.slice(0, MCP_COLLECTION_HINT_NAMES).map((e) => e.name);
  const rest = endpoints.length - shown.length;
  const names = rest > 0 ? `${shown.join(', ')} and ${rest} more` : shown.join(', ');
  const count = endpoints.length === 1 ? '1 endpoint' : `${endpoints.length} endpoints`;
  return `Includes ${count} from the current catalog view: ${names}.`;
}
