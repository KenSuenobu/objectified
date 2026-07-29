import {
  buildNamespaceGroups,
  isWithinNamespace,
  namespaceParentPath,
  sortNamespaceTree,
  type NamespaceTreeEntry,
  type PathedSortRow,
} from '@/app/utils/primitives-namespace-groups';

const row = (path: string | null, over: Partial<PathedSortRow> = {}): PathedSortRow => ({
  key: over.key ?? `key-${path ?? 'none'}`,
  kind: over.kind ?? 'registered',
  sortName: over.sortName ?? path ?? 'Unassigned namespaces',
  path,
  scope: over.scope ?? 'tenant',
  typeCount: over.typeCount ?? 1,
  draft: over.draft ?? '2020-12',
  unresolvedCount: over.unresolvedCount ?? 0,
});

/** A readable shape for asserting tree structure: group prefixes with their member paths. */
function shape(entries: NamespaceTreeEntry<PathedSortRow>[]) {
  return entries.map((entry) =>
    entry.kind === 'group'
      ? { group: entry.group.prefix, members: entry.group.members.map((m) => m.path) }
      : { row: entry.row.path },
  );
}

describe('namespaceParentPath', () => {
  it('drops the last segment', () => {
    expect(namespaceParentPath('self/v1/schemas/a')).toBe('self/v1/schemas');
    expect(namespaceParentPath('std/v0/types')).toBe('std/v0');
  });

  it('handles leading slashes and trailing slashes', () => {
    expect(namespaceParentPath('/v1/schemas/a')).toBe('/v1/schemas');
    expect(namespaceParentPath('self/v1/schemas/')).toBe('self/v1');
  });

  it('returns null when there is no parent to group under', () => {
    expect(namespaceParentPath('types')).toBeNull();
    expect(namespaceParentPath('/v1')).toBeNull();
    expect(namespaceParentPath('')).toBeNull();
  });
});

describe('isWithinNamespace', () => {
  it('matches the prefix itself and its descendants', () => {
    expect(isWithinNamespace('/v1/schemas', '/v1/schemas')).toBe(true);
    expect(isWithinNamespace('/v1/schemas/a', '/v1/schemas')).toBe(true);
    expect(isWithinNamespace('/v1/schemas/a/deep', '/v1/schemas')).toBe(true);
  });

  it('does not match a sibling that merely starts with the same characters', () => {
    expect(isWithinNamespace('/v1/schemas-legacy/a', '/v1/schemas')).toBe(false);
    expect(isWithinNamespace('/v1/other', '/v1/schemas')).toBe(false);
  });
});

describe('buildNamespaceGroups', () => {
  it('collapses siblings under their shared parent', () => {
    const entries = buildNamespaceGroups([row('/v1/schemas/a'), row('/v1/schemas/b')]);

    expect(shape(entries)).toEqual([
      { group: '/v1/schemas', members: ['/v1/schemas/a', '/v1/schemas/b'] },
    ]);
  });

  it('leaves a namespace with no sibling as its own row', () => {
    const entries = buildNamespaceGroups([row('/v1/schemas/a'), row('/v2/other/b')]);

    expect(shape(entries)).toEqual([{ row: '/v1/schemas/a' }, { row: '/v2/other/b' }]);
  });

  it('never groups a row that sits on no path', () => {
    const entries = buildNamespaceGroups([
      row('/v1/schemas/a'),
      row('/v1/schemas/b'),
      row(null, { key: 'unassigned', kind: 'unassigned' }),
    ]);

    expect(shape(entries)).toEqual([
      { group: '/v1/schemas', members: ['/v1/schemas/a', '/v1/schemas/b'] },
      { row: null },
    ]);
  });

  it('makes a collection registered at the prefix the root of its own group', () => {
    const entries = buildNamespaceGroups([row('/v1/schemas/a'), row('/v1/schemas')]);

    expect(shape(entries)).toEqual([
      // The root sorts to the head of its family, ahead of the descendant declared before it.
      { group: '/v1/schemas', members: ['/v1/schemas', '/v1/schemas/a'] },
    ]);
    const group = entries[0].kind === 'group' ? entries[0].group : null;
    expect(group?.rootKeys.has('key-/v1/schemas')).toBe(true);
    expect(group?.rootKeys.has('key-/v1/schemas/a')).toBe(false);
  });

  it('prefers heading your own family over being a child of your parent’s', () => {
    // `/v1/schemas` could be a child of a `/v1` group, but it heads `/v1/schemas` instead — which
    // starves `/v1` down to one member, so that group is dropped and its row returns to top level.
    const entries = buildNamespaceGroups([
      row('/v1/schemas'),
      row('/v1/other'),
      row('/v1/schemas/a'),
    ]);

    expect(shape(entries)).toEqual([
      { group: '/v1/schemas', members: ['/v1/schemas', '/v1/schemas/a'] },
      { row: '/v1/other' },
    ]);
  });

  it('keeps a group at the position of its earliest member', () => {
    const entries = buildNamespaceGroups([
      row('zz/one/first'),
      row('/v1/schemas/a'),
      row('/v1/schemas/b'),
    ]);

    expect(shape(entries)).toEqual([
      { row: 'zz/one/first' },
      { group: '/v1/schemas', members: ['/v1/schemas/a', '/v1/schemas/b'] },
    ]);
  });

  it('respects a raised member threshold', () => {
    const two = [row('/v1/schemas/a'), row('/v1/schemas/b')];
    expect(shape(buildNamespaceGroups(two, 3))).toEqual([
      { row: '/v1/schemas/a' },
      { row: '/v1/schemas/b' },
    ]);
  });

  it('aggregates type and unresolved counts onto the header', () => {
    const entries = buildNamespaceGroups([
      row('/v1/schemas/a', { typeCount: 4, unresolvedCount: 2 }),
      row('/v1/schemas/b', { typeCount: 6, unresolvedCount: 1 }),
    ]);

    const header = entries[0].kind === 'group' ? entries[0].group.header : null;
    expect(header?.typeCount).toBe(10);
    expect(header?.unresolvedCount).toBe(3);
    expect(header?.collectionCount).toBe(2);
    expect(header?.scope).toBe('tenant');
    expect(header?.scopeMixed).toBe(false);
    expect(header?.draft).toBe('2020-12');
  });

  it('reports a mixed scope rather than picking one member’s', () => {
    const entries = buildNamespaceGroups([
      row('/v1/schemas/a', { scope: 'system' }),
      row('/v1/schemas/b', { scope: 'tenant' }),
    ]);

    const header = entries[0].kind === 'group' ? entries[0].group.header : null;
    expect(header?.scopeMixed).toBe(true);
    expect(header?.scope).toBeNull();
  });

  it('groups unregistered namespaces alongside registered ones', () => {
    const entries = buildNamespaceGroups([
      row('/v1/schemas/a', { kind: 'registered' }),
      row('/v1/schemas/b', { kind: 'detected' }),
    ]);

    expect(shape(entries)).toEqual([
      { group: '/v1/schemas', members: ['/v1/schemas/a', '/v1/schemas/b'] },
    ]);
    const header = entries[0].kind === 'group' ? entries[0].group.header : null;
    // A family containing a registered collection reads as registered for tiebreak purposes.
    expect(header?.kind).toBe('registered');
  });
});

describe('sortNamespaceTree', () => {
  const entries = buildNamespaceGroups([
    row('/v1/schemas/a', { key: 'a', typeCount: 4 }),
    row('/v1/schemas/b', { key: 'b', typeCount: 6 }),
    row('/v9/solo/only', { key: 'solo', typeCount: 30 }),
  ]);

  it('leaves the tree in input order with no column selected', () => {
    expect(shape(sortNamespaceTree(entries, null, 'asc'))).toEqual(shape(entries));
  });

  it('orders groups by their aggregate against ungrouped rows', () => {
    // The group totals 10 types, the solo row has 30.
    expect(shape(sortNamespaceTree(entries, 'types', 'asc'))).toEqual([
      { group: '/v1/schemas', members: ['/v1/schemas/a', '/v1/schemas/b'] },
      { row: '/v9/solo/only' },
    ]);
    expect(shape(sortNamespaceTree(entries, 'types', 'desc'))).toEqual([
      { row: '/v9/solo/only' },
      { group: '/v1/schemas', members: ['/v1/schemas/b', '/v1/schemas/a'] },
    ]);
  });

  it('sorts members inside their group without lifting them out of it', () => {
    const sorted = sortNamespaceTree(entries, 'types', 'desc');
    const group = sorted.find((entry) => entry.kind === 'group');
    expect(group?.kind === 'group' && group.group.members.map((m) => m.key)).toEqual(['b', 'a']);
  });

  it('keeps the group root at the head of its family whichever way it sorts', () => {
    const withRoot = buildNamespaceGroups([
      row('/v1/schemas', { key: 'root', typeCount: 1 }),
      row('/v1/schemas/a', { key: 'a', typeCount: 50 }),
    ]);

    for (const direction of ['asc', 'desc'] as const) {
      const sorted = sortNamespaceTree(withRoot, 'types', direction);
      const group = sorted.find((entry) => entry.kind === 'group');
      expect(group?.kind === 'group' && group.group.members[0].key).toBe('root');
    }
  });

  it('does not mutate the entries it was given', () => {
    const before = shape(entries);
    sortNamespaceTree(entries, 'types', 'desc');
    expect(shape(entries)).toEqual(before);
  });
});
