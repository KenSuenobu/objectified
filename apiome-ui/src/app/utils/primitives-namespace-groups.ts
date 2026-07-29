/**
 * Groups the Primitives dashboard's "Type collections" rows under their shared parent namespace.
 *
 * Namespaces are slash-delimited paths, and a tenant that imports a few schema bundles ends up with
 * `self/v1/schemas/a`, `self/v1/schemas/b`, … as unrelated top-level rows even though they are one
 * family. Grouping collapses them under `self/v1/schemas`, so the panel opens on the handful of
 * roots the tenant actually has rather than on every leaf.
 *
 * Grouping is **one level deep, by immediate parent path**. That is what the shapes in the registry
 * call for (`std/v0/types` + `std/v0/primitives` → `std/v0`) and it keeps the table a two-level list
 * rather than an arbitrarily deep tree with its own expand-all/collapse-all problem.
 *
 * A group only forms at {@link MIN_GROUP_MEMBERS} members: nesting a lone namespace under a
 * synthetic parent adds a row and tells the reader nothing.
 */

import {
  compareNamespaceCollectionRows,
  type NamespaceCollectionSortColumn,
  type NamespaceCollectionSortDirection,
  type NamespaceCollectionSortRow,
} from './primitives-namespaces-sort';

/** Below this, a shared parent is not worth a row of its own. */
export const MIN_GROUP_MEMBERS = 2;

/** A namespace family: the shared parent path, an aggregate header row, and its members. */
export interface NamespaceGroupNode<T extends NamespaceCollectionSortRow> {
  /** The shared parent path, e.g. `self/v1/schemas`. */
  prefix: string;
  /** The aggregate row the header renders and the sorter orders the group by. */
  header: NamespaceCollectionSortRow & { collectionCount: number; scopeMixed: boolean };
  /**
   * The grouped rows. A member whose own path *is* the prefix (a registered collection at the root
   * of its family) sorts first and is flagged {@link isGroupRoot}, so the header can stay synthetic
   * instead of swallowing a real row's scope, description, and exact-match click.
   */
  members: T[];
  /** Keys of members that are the registered collection at the prefix itself. */
  rootKeys: ReadonlySet<string>;
}

/** One line of the rendered table: either a group with its members, or a row that has no family. */
export type NamespaceTreeEntry<T extends NamespaceCollectionSortRow> =
  | { kind: 'group'; group: NamespaceGroupNode<T> }
  | { kind: 'row'; row: T };

/** A sort row that knows its namespace path; `null` for rows that are not on any path. */
export type PathedSortRow = NamespaceCollectionSortRow & { path: string | null };

/**
 * The parent of a namespace path, or `null` when it has none.
 *
 * A single leading segment has no parent to group under — `v1` and `/v1` are already as shallow as
 * a path gets, so neither yields an empty-string prefix.
 */
export function namespaceParentPath(namespace: string): string | null {
  const trimmed = namespace.trim().replace(/\/+$/, '');
  const cut = trimmed.lastIndexOf('/');
  // `cut === 0` is a leading-slash path like `/v1`: the parent would be the empty string.
  if (cut <= 0) return null;
  return trimmed.slice(0, cut);
}

/** Whether `namespace` is `prefix` itself or sits underneath it. */
export function isWithinNamespace(namespace: string, prefix: string): boolean {
  const ns = namespace.trim();
  const root = prefix.trim().replace(/\/+$/, '');
  return ns === root || ns.startsWith(`${root}/`);
}

function pushMember<T>(buckets: Map<string, T[]>, key: string, value: T): void {
  const existing = buckets.get(key);
  if (existing) existing.push(value);
  else buckets.set(key, [value]);
}

function buildHeader<T extends PathedSortRow>(
  prefix: string,
  members: readonly T[],
): NamespaceGroupNode<T>['header'] {
  const scopes = new Set(members.map((m) => m.scope));
  const drafts = new Set(members.map((m) => m.draft));
  const scopeMixed = scopes.size > 1;
  return {
    key: `group-${prefix}`,
    // A family of registered collections reads as one; only an all-unregistered family is 'detected'.
    kind: members.some((m) => m.kind === 'registered') ? 'registered' : 'detected',
    sortName: prefix,
    scope: scopeMixed ? null : (members[0]?.scope ?? null),
    typeCount: members.reduce((sum, m) => sum + m.typeCount, 0),
    draft: drafts.size === 1 ? (members[0]?.draft ?? '') : '',
    unresolvedCount: members.reduce((sum, m) => sum + m.unresolvedCount, 0),
    collectionCount: members.length,
    scopeMixed,
  };
}

/**
 * Collapse rows that share an immediate parent into groups.
 *
 * Top-level order follows the input: a group takes the position of its earliest member, so an
 * unsorted table stays in registry order. Rows with a `null` path (the unassigned bucket) are never
 * grouped.
 *
 * @param rows The panel's flat rows, in the order they would otherwise render.
 * @param minMembers How many members a shared parent needs before it becomes a group.
 * @returns Groups and ungrouped rows, interleaved in input order.
 */
export function buildNamespaceGroups<T extends PathedSortRow>(
  rows: readonly T[],
  minMembers: number = MIN_GROUP_MEMBERS,
): NamespaceTreeEntry<T>[] {
  const rowByPath = new Map<string, T>();
  const childrenByParent = new Map<string, T[]>();

  for (const row of rows) {
    if (!row.path) continue;
    if (!rowByPath.has(row.path)) rowByPath.set(row.path, row);
    const parent = namespaceParentPath(row.path);
    if (parent) pushMember(childrenByParent, parent, row);
  }

  // A prefix is a candidate once its children plus any collection registered at the prefix itself
  // reach the threshold.
  const candidates = new Set<string>();
  for (const [prefix, children] of childrenByParent) {
    if (children.length + (rowByPath.has(prefix) ? 1 : 0) >= minMembers) candidates.add(prefix);
  }

  // Assign each row to the most specific candidate it belongs to: being the root of your own family
  // beats being a child of your parent's, so `/v1/schemas` heads its group rather than sitting
  // inside `/v1`.
  const membersByPrefix = new Map<string, T[]>();
  const rootKeysByPrefix = new Map<string, Set<string>>();
  const prefixByRowKey = new Map<string, string>();

  for (const row of rows) {
    if (!row.path) continue;
    if (candidates.has(row.path) && rowByPath.get(row.path) === row) {
      pushMember(membersByPrefix, row.path, row);
      const roots = rootKeysByPrefix.get(row.path) ?? new Set<string>();
      roots.add(row.key);
      rootKeysByPrefix.set(row.path, roots);
      prefixByRowKey.set(row.key, row.path);
      continue;
    }
    const parent = namespaceParentPath(row.path);
    if (parent && candidates.has(parent)) {
      pushMember(membersByPrefix, parent, row);
      prefixByRowKey.set(row.key, parent);
    }
  }

  // Promoting the roots can starve a group — `/v1` loses `/v1/schemas` to its own family — so the
  // threshold is re-checked on the final membership. A dropped group's rows return to top level.
  const surviving = new Set<string>();
  for (const [prefix, members] of membersByPrefix) {
    if (members.length >= minMembers) surviving.add(prefix);
  }

  const entries: NamespaceTreeEntry<T>[] = [];
  const emitted = new Set<string>();

  for (const row of rows) {
    const prefix = row.path ? prefixByRowKey.get(row.key) : undefined;
    if (!prefix || !surviving.has(prefix)) {
      entries.push({ kind: 'row', row });
      continue;
    }
    if (emitted.has(prefix)) continue;
    emitted.add(prefix);
    const rootKeys = rootKeysByPrefix.get(prefix) ?? new Set<string>();
    // The collection registered at the prefix heads its family even before any sort is applied —
    // it is the group's root, not a peer of its descendants.
    const members = [...(membersByPrefix.get(prefix) ?? [])].sort(
      (a, b) => Number(rootKeys.has(b.key)) - Number(rootKeys.has(a.key)),
    );
    entries.push({
      kind: 'group',
      group: { prefix, header: buildHeader(prefix, members), members, rootKeys },
    });
  }

  return entries;
}

/** The row a top-level entry is ordered by: a group sorts on its aggregate header. */
function entrySortRow<T extends NamespaceCollectionSortRow>(
  entry: NamespaceTreeEntry<T>,
): NamespaceCollectionSortRow {
  return entry.kind === 'group' ? entry.group.header : entry.row;
}

/**
 * Sort the tree: top-level entries against each other, and each group's members among themselves.
 *
 * A group keeps its members — sorting reorders families and their contents, it never lifts a member
 * out to be compared against unrelated rows. `column: null` leaves everything in input order.
 */
export function sortNamespaceTree<T extends NamespaceCollectionSortRow>(
  entries: readonly NamespaceTreeEntry<T>[],
  column: NamespaceCollectionSortColumn | null,
  direction: NamespaceCollectionSortDirection,
): NamespaceTreeEntry<T>[] {
  if (!column) return [...entries];

  const sorted = entries.map((entry) => {
    if (entry.kind !== 'group') return entry;
    const members = [...entry.group.members].sort((a, b) =>
      compareNamespaceCollectionRows(a, b, column, direction),
    );
    // The collection registered at the prefix itself stays at the head of its family: it is the
    // group's root, not a peer of its descendants.
    members.sort((a, b) => Number(entry.group.rootKeys.has(b.key)) - Number(entry.group.rootKeys.has(a.key)));
    return { kind: 'group' as const, group: { ...entry.group, members } };
  });

  return sorted.sort((a, b) =>
    compareNamespaceCollectionRows(entrySortRow(a), entrySortRow(b), column, direction),
  );
}
