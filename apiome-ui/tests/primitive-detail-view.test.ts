/**
 * The decisions the primitive-detail screen makes (HIVE-6.6, #5317).
 *
 * `primitive-detail-hive.test.tsx` renders the screen and `primitive-detail-css.test.ts` pins the
 * declarations; this holds the rules underneath both, so each one is asserted once rather than
 * through whichever card happens to draw it.
 *
 * The ticket's first acceptance criterion is that **live validation gives the same verdicts as
 * today, including the loose-validation caveat**. That is a claim about *sentences*, so the
 * sentences moved out of the component into {@link verdict} and {@link looseValidationNote}
 * unchanged, and every branch of both is pinned here against the wording the pre-Hive card
 * produced.
 */

import {
  COPY_ACK_MS,
  DEFAULT_DRAFT,
  DEPRECATE_REASON,
  EMPTY_OBJECT_NOTE,
  EMPTY_VALUE,
  LIVE_VALIDATION_NOTE,
  NO_DEPENDENTS_TITLE,
  NO_ITEM_SCHEMA_NOTE,
  NO_REFS_TITLE,
  OMITTED_NOTE,
  SYSTEM_IMMUTABLE_REASON,
  chainStepMeta,
  chainStepState,
  collectCoercionErrors,
  copyButtonState,
  dependentLabel,
  dependentScope,
  dependentsFootLabel,
  describeFieldType,
  detailBreadcrumb,
  editAffordance,
  extraKeyMessage,
  formatCreated,
  headerBadges,
  isScalarField,
  looseValidationNote,
  metadataRows,
  mutability,
  patternMatchAttribute,
  patternVerdictLabel,
  problemCount,
  refEdgeStatus,
  refsFootLabel,
  schemaPaneHeight,
  usageTiles,
  verdict,
} from '../src/app/components/ade/primitives/detail/primitiveDetailView';
import {
  buildTestField,
  seedStateFromInstance,
} from '../src/app/ade/dashboard/primitives/primitiveTestForm';

describe('the header', () => {
  it('badges a tenant type with its scope, JSON type and dialect', () => {
    const badges = headerBadges({ is_system: false, category: 'object', draft: '2020-12' });

    expect(badges.map((badge) => [badge.id, badge.label])).toEqual([
      ['scope', 'Tenant'],
      ['category', 'object'],
      ['draft', 'draft 2020-12'],
    ]);
    // Identifiers are monospaced; a scope is a word.
    expect(badges.map((badge) => Boolean(badge.mono))).toEqual([false, true, true]);
  });

  it('adds the immutability lock for a system type, and only for one', () => {
    const system = headerBadges({ is_system: true, category: 'string', draft: '2020-12' });
    const tenant = headerBadges({ is_system: false, category: 'string', draft: '2020-12' });

    expect(system.map((badge) => badge.id)).toContain('immutable');
    expect(system[0].label).toBe('System · core');
    expect(tenant.map((badge) => badge.id)).not.toContain('immutable');
  });

  it('falls back to the current dialect when the row names none', () => {
    const [, , draft] = headerBadges({ is_system: false, category: 'object' });
    expect(draft.label).toBe(`draft ${DEFAULT_DRAFT}`);
  });

  it('refuses Edit for a system type, with the reason as the tooltip', () => {
    const edit = editAffordance({ id: 'p-1', is_system: true });

    expect(edit).toEqual({ disabled: true, title: SYSTEM_IMMUTABLE_REASON, href: null });
  });

  it('sends a tenant type to the registry editor on its own id', () => {
    const edit = editAffordance({ id: 'p-2', is_system: false });

    expect(edit.disabled).toBe(false);
    expect(edit.href).toBe('/ade/dashboard/primitives?edit=p-2');
  });

  it('names the ticket that will make Deprecate work', () => {
    expect(DEPRECATE_REASON).toContain('#3482');
  });

  it('ends the breadcrumb at the namespace, not at the type the h1 already names', () => {
    expect(detailBreadcrumb('tenant/acme/v1/types').map((step) => step.label)).toEqual([
      'Home',
      'Build',
      'Primitives & types',
      'tenant/acme/v1/types',
    ]);
  });

  it('drops the last step rather than printing an empty one', () => {
    expect(detailBreadcrumb(null)).toHaveLength(3);
  });
});

describe('the schema pane', () => {
  it('sizes the box in rem, so it follows the font-scale preference', () => {
    expect(schemaPaneHeight('{}')).toMatch(/^[\d.]+rem$/);
  });

  it('gives a two-line schema the floor rather than a two-line box', () => {
    expect(schemaPaneHeight('{\n}')).toBe('12.5rem');
  });

  it('stops a sprawling schema at the ceiling and lets it scroll inside', () => {
    const long = Array.from({ length: 400 }, (_unused, index) => `"line-${index}": 1`).join('\n');

    expect(schemaPaneHeight(long)).toBe('35rem');
  });

  it('grows with the document between the two', () => {
    const short = Number.parseFloat(schemaPaneHeight('a\n'.repeat(20)));
    const longer = Number.parseFloat(schemaPaneHeight('a\n'.repeat(24)));

    expect(longer).toBeGreaterThan(short);
    expect(longer).toBeLessThan(35);
  });

  it('never asks for a zero-height box for an empty document', () => {
    expect(schemaPaneHeight('')).toBe('12.5rem');
  });

  it('says Copy, then acknowledges, then says why a write failed', () => {
    expect(copyButtonState(false, false).label).toBe('Copy');
    expect(copyButtonState(true, false).label).toBe('Copied');
    expect(copyButtonState(false, true).label).toBe('Copy failed');
    // A failed write is *not* an acknowledgement of success, and says what went wrong.
    expect(copyButtonState(false, true).title).toMatch(/could not write/i);
    expect(COPY_ACK_MS).toBeGreaterThan(0);
  });
});

describe('reference resolution', () => {
  it('tones the three stored statuses through the shared vocabulary', () => {
    expect(refEdgeStatus('resolved')).toEqual({ tone: 'ok', label: 'Resolved' });
    expect(refEdgeStatus('unresolved')).toEqual({ tone: 'warn', label: 'Unresolved' });
    expect(refEdgeStatus('circular')).toEqual({ tone: 'danger', label: 'Circular' });
  });

  it('keeps an unknown status readable rather than mis-colouring it', () => {
    // A status this UI has not heard of keeps its own text and takes no tone at all.
    expect(refEdgeStatus('deferred')).toEqual({ tone: 'neutral', label: 'deferred' });
    expect(refEdgeStatus(undefined)).toEqual({ tone: 'neutral', label: 'unknown' });
    expect(refEdgeStatus('  ')).toEqual({ tone: 'neutral', label: 'unknown' });
  });

  it('names the base only when there is one to name', () => {
    expect(refsFootLabel('https://api.apiome.dev/types/std/v0/types/')).toBe(
      'Base: https://api.apiome.dev/types/std/v0/types/'
    );
    expect(refsFootLabel(null)).toBeNull();
    expect(refsFootLabel(undefined)).toBeNull();
  });

  it('teaches rather than reporting nothing when a type has no relative $ref', () => {
    expect(NO_REFS_TITLE).toMatch(/no relative \$ref/i);
  });
});

describe('dependents', () => {
  it('names a dependent by its namespace and type name', () => {
    expect(
      dependentLabel({ namespace: 'tenant/acme/v1/types', name: 'invoice' })
    ).toBe('tenant/acme/v1/types/invoice');
  });

  it('falls back to the name, then the $id, then an em dash', () => {
    expect(dependentLabel({ name: 'invoice' })).toBe('invoice');
    expect(dependentLabel({ schema_id: 'https://x/invoice' })).toBe('https://x/invoice');
    expect(dependentLabel({})).toBe(EMPTY_VALUE);
  });

  it('words a dependent’s scope exactly as the header words the type’s own', () => {
    expect(dependentScope({ scope: 'system' })).toEqual({ label: 'System · core', tone: 'accent' });
    expect(dependentScope({ scope: 'tenant', tenant_label: 'acme' })).toEqual({
      label: 'Tenant · acme',
      tone: 'violet',
    });
    // No slug in the reverse index — the scope is still known, the tenant is not.
    expect(dependentScope({ scope: 'tenant' }).label).toBe('Tenant');
  });

  it('counts dependents in the singular when there is one', () => {
    expect(dependentsFootLabel(1)).toBe('1 dependent');
    expect(dependentsFootLabel(0)).toBe('0 dependents');
    expect(dependentsFootLabel(3)).toBe('3 dependents');
  });

  it('teaches how a dependent would get here', () => {
    expect(NO_DEPENDENTS_TITLE).toMatch(/no type in view references this one/i);
  });
});

describe('the metadata aside', () => {
  it('lists all eight rows in the mockup’s order, Scope second', () => {
    const rows = metadataRows({
      isSystem: false,
      schemaId: 'https://api.apiome.dev/types/tenant/acme/v1/types/money',
      namespace: 'tenant/acme/v1/types',
      versionRoot: 'v1',
      owner: 'acme',
      source: 'human',
      createdAt: '2026-06-18T09:00:00.000Z',
    });

    expect(rows.map((row) => [row.id, row.value])).toEqual([
      ['id', 'https://api.apiome.dev/types/tenant/acme/v1/types/money'],
      ['scope', 'Tenant'],
      ['namespace', 'tenant/acme/v1/types'],
      ['version-root', 'v1'],
      ['owner', 'acme'],
      ['source', 'human'],
      ['created', '2026-06-18'],
      ['mutability', 'editable · tenant'],
    ]);
  });

  it('says how each row is drawn, so the two that are not printed keep their place', () => {
    const rows = metadataRows({ isSystem: true, namespace: null, versionRoot: null, owner: 'system' });
    const byId = Object.fromEntries(rows.map((row) => [row.id, row]));

    expect(byId.scope.kind).toBe('scope');
    expect(byId.mutability.kind).toBe('mutability');
    expect(byId.id.kind).toBe('text');
    // The four identifiers are monospaced; the two words and the date are not.
    expect(rows.filter((row) => row.mono).map((row) => row.id)).toEqual([
      'id',
      'namespace',
      'version-root',
      'owner',
    ]);
    // A system type's two drawn rows carry its own words.
    expect(byId.scope.value).toBe('System · core');
    expect(byId.mutability.value).toBe('immutable · core');
  });

  it('prints one em dash for every field the row does not carry', () => {
    const rows = metadataRows({
      isSystem: false,
      namespace: null,
      versionRoot: null,
      owner: 'tenant',
    });
    const byId = Object.fromEntries(rows.map((row) => [row.id, row.value]));

    expect(byId.id).toBe(EMPTY_VALUE);
    expect(byId.namespace).toBe(EMPTY_VALUE);
    expect(byId['version-root']).toBe(EMPTY_VALUE);
    expect(byId.created).toBe(EMPTY_VALUE);
    // A missing `source` is the API's own default, not unknown provenance.
    expect(byId.source).toBe('human');
  });

  it('reads a timestamp as a date, and refuses to print `Invalid Date`', () => {
    expect(formatCreated('2026-06-18T23:59:59.000Z')).toBe('2026-06-18');
    expect(formatCreated('not a date')).toBe(EMPTY_VALUE);
    expect(formatCreated(null)).toBe(EMPTY_VALUE);
    expect(formatCreated(undefined)).toBe(EMPTY_VALUE);
  });

  it('locks a system type and leaves a tenant type editable', () => {
    expect(mutability(true)).toEqual({ label: 'immutable · core', locked: true });
    expect(mutability(false)).toEqual({ label: 'editable · tenant', locked: false });
  });

  it('names the three used-in counters without recomputing them', () => {
    expect(usageTiles({ dependentTypes: 3, properties: 14, tenants: 1 })).toEqual([
      { id: 'dependent-types', label: 'Dependent types', value: 3 },
      { id: 'properties', label: 'Properties', value: 14 },
      { id: 'tenants', label: 'Tenants', value: 1 },
    ]);
  });
});

describe('the base chain', () => {
  it('marks the head node as the type being viewed', () => {
    expect(chainStepState({ kind: 'self' })).toBe('self');
    expect(chainStepMeta({ kind: 'self' }, 'object')).toBe('object · this type');
  });

  it('marks a hop by its own status, defaulting to resolved', () => {
    expect(chainStepState({ kind: 'ref', status: 'resolved' })).toBe('resolved');
    expect(chainStepState({ kind: 'ref', status: 'unresolved' })).toBe('unresolved');
    // An edge stored before the resolver ran carries no status; it is not a failure.
    expect(chainStepState({ kind: 'ref' })).toBe('resolved');
  });

  it('says where a hop goes, and says the word when it goes nowhere', () => {
    expect(chainStepMeta({ kind: 'ref', target: 'std/v0/types/decimal' }, 'object')).toBe(
      '→ std/v0/types/decimal'
    );
    expect(
      chainStepMeta({ kind: 'ref', target: 'std/v0/types/decimal', status: 'unresolved' }, 'object')
    ).toBe('→ std/v0/types/decimal · unresolved');
    // No target at all — the state has to survive a reader who cannot see the amber rail.
    expect(chainStepMeta({ kind: 'ref', status: 'unresolved' }, 'object')).toBe('unresolved');
  });
});

describe('the test form’s verdict', () => {
  it('says the instance is valid when nothing is wrong with it', () => {
    expect(verdict({ status: 'valid', findingCount: 0 }, false)).toEqual({
      tone: 'ok',
      message: 'Valid against this schema',
      status: 'valid',
    });
  });

  it('counts the problems, in the singular when there is one', () => {
    expect(verdict({ status: 'invalid', findingCount: 1 }, false).message).toBe('1 problem found');
    expect(verdict({ status: 'invalid', findingCount: 2 }, false).message).toBe('2 problems found');
    expect(problemCount(1)).toBe('1 problem');
    expect(problemCount(0)).toBe('0 problems');
  });

  it('puts an unreadable box ahead of every schema finding', () => {
    // The instance is not well-formed yet, so there is nothing meaningful to have validated.
    const bar = verdict({ status: 'valid', findingCount: 0 }, true);

    expect(bar.message).toBe('Some inputs are not valid values yet');
    expect(bar.tone).toBe('danger');
    // …and the bar still reports `invalid`, which is what the suites and the reader both need.
    expect(bar.status).toBe('invalid');
  });

  it('treats a schema that will not compile as amber, not red', () => {
    const bar = verdict(
      { status: 'unavailable', findingCount: 0, schemaError: 'unknown keyword' },
      false
    );

    expect(bar).toEqual({
      tone: 'warn',
      message: 'Schema could not be compiled — unknown keyword',
      status: 'unavailable',
    });
  });

  it('names the compile failure even when the error did not', () => {
    expect(verdict({ status: 'unavailable', findingCount: 0 }, false).message).toBe(
      'Schema could not be compiled — unknown error'
    );
  });

  it('lets a compile failure outrank an unreadable box', () => {
    // Nothing the reader typed is wrong when the schema itself never compiled.
    expect(verdict({ status: 'unavailable', findingCount: 0, schemaError: 'boom' }, true).tone).toBe(
      'warn'
    );
  });

  it('states the loose-validation caveat, naming every $ref it could not follow', () => {
    const note = looseValidationNote(['../a', '../b']);

    expect(note).toContain('../a, ../b');
    expect(note).toMatch(/could not be resolved in the browser/);
    expect(note).toMatch(/not checked here/);
  });

  it('adds no caveat when everything resolved', () => {
    expect(looseValidationNote([])).toBeNull();
  });

  it('says there is no button to press', () => {
    expect(LIVE_VALIDATION_NOTE).toMatch(/no need to press anything/i);
  });
});

describe('the test form’s field tree', () => {
  it('hints a field’s type, its format, and an unfollowable $ref', () => {
    expect(describeFieldType({ kind: 'string' })).toBe('string');
    expect(describeFieldType({ kind: 'string', format: 'email' })).toBe('string · email');
    expect(describeFieldType({ kind: 'enum' })).toBe('enum');
    expect(describeFieldType({ kind: 'string', unresolvedRef: '../decimal' })).toBe(
      '$ref ../decimal'
    );
    // A `$ref` outranks a format: what the box takes is raw JSON either way.
    expect(describeFieldType({ kind: 'string', format: 'email', unresolvedRef: '../x' })).toBe(
      '$ref ../x'
    );
  });

  it('labels only a field that has a control of its own', () => {
    // A container's name cannot be a `<label for>` — there is no one box for it to name.
    expect(isScalarField({ kind: 'string' })).toBe(true);
    expect(isScalarField({ kind: 'enum' })).toBe(true);
    expect(isScalarField({ kind: 'object' })).toBe(false);
    expect(isScalarField({ kind: 'array' })).toBe(false);
  });

  it('words the two reasons a dynamic-property row stays out of the instance', () => {
    expect(extraKeyMessage('empty', '')).toMatch(/name this property/i);
    expect(extraKeyMessage('duplicate', 'amount')).toBe(
      '"amount" is already a property of this object — rename or remove this row.'
    );
  });

  it('words the live pattern verdict, including the regex it cannot run', () => {
    expect(patternVerdictLabel(true)).toBe('matches');
    expect(patternVerdictLabel(false)).toBe('does not match');
    expect(patternVerdictLabel(null)).toBe('is not a regex this browser can run');
    expect(patternMatchAttribute(true)).toBe('true');
    expect(patternMatchAttribute(false)).toBe('false');
    expect(patternMatchAttribute(null)).toBe('invalid-pattern');
  });

  it('teaches, rather than showing a blank form, when there is nothing to fill in', () => {
    expect(EMPTY_OBJECT_NOTE).toMatch(/nothing to fill in/i);
    expect(NO_ITEM_SCHEMA_NOTE).toMatch(/does not declare an item schema/i);
    expect(OMITTED_NOTE).toMatch(/omitted from the instance/i);
  });
});

describe('coercion errors', () => {
  const SCHEMA = {
    type: 'object',
    properties: {
      count: { type: 'integer' },
      label: { type: 'string' },
      nested: { type: 'object', properties: { size: { type: 'number' } } },
      list: { type: 'array', items: { type: 'integer' } },
    },
    required: ['count'],
  };

  const field = buildTestField(SCHEMA, { label: 'thing' });
  const seeded = seedStateFromInstance(field, {
    count: 1,
    label: 'x',
    nested: { size: 2 },
    list: [3],
  });

  it('finds nothing wrong with a well-formed instance', () => {
    expect(collectCoercionErrors(field, seeded).size).toBe(0);
  });

  it('reports a box holding something that is not the field’s type', () => {
    const state = { ...seeded, values: { ...seeded.values, '/count': 'abc' } };

    expect(collectCoercionErrors(field, state).get('/count')).toMatch(/number/i);
  });

  it('walks into nested objects and array elements', () => {
    const state = {
      ...seeded,
      values: { ...seeded.values, '/nested/size': 'nope', '/list/0': 'nope' },
    };
    const errors = collectCoercionErrors(field, state);

    expect(errors.has('/nested/size')).toBe(true);
    expect(errors.has('/list/0')).toBe(true);
  });

  it('ignores a property that is switched off — it is not in the document', () => {
    const state = {
      ...seeded,
      values: { ...seeded.values, '/label': 'fine', '/count': 'abc' },
      included: { ...seeded.included, '/count': false },
    };

    expect(collectCoercionErrors(field, state).size).toBe(0);
  });
});
