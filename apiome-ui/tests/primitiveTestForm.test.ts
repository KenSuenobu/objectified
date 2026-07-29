/**
 * Pure-model tests for the Primitives "Test this type" form.
 *
 * Covers the schema → form projection, instance building, live regex evaluation, and the Ajv
 * validation wrapper (including the unresolved-`$ref` degradation that keeps a referencing type
 * testable in the browser).
 */

import {
  arrayLength,
  buildInstance,
  buildTestField,
  childPointer,
  coerceScalar,
  compileTestValidator,
  deriveFieldKind,
  escapePointerToken,
  findingsByPointer,
  isIncluded,
  patternMatches,
  sanitizeForValidation,
  seedStateFromInstance,
  MAX_FORM_DEPTH,
  type TestFormState,
} from '../src/app/ade/dashboard/primitives/primitiveTestForm';

const MONEY_SCHEMA = {
  $id: 'https://api.apiome.app/types/std/v0/types/money',
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  type: 'object',
  properties: {
    amount: { type: 'string', pattern: '^[0-9]+\\.[0-9]{2}$' },
    currency: { type: 'string', minLength: 3, maxLength: 3 },
    note: { type: 'string' },
  },
  required: ['amount', 'currency'],
};

const emptyState = (): TestFormState => ({ values: {}, arrayLengths: {}, included: {} });

describe('deriveFieldKind', () => {
  it('maps declared scalar and container types', () => {
    expect(deriveFieldKind({ type: 'string' })).toBe('string');
    expect(deriveFieldKind({ type: 'integer' })).toBe('integer');
    expect(deriveFieldKind({ type: 'number' })).toBe('number');
    expect(deriveFieldKind({ type: 'boolean' })).toBe('boolean');
    expect(deriveFieldKind({ type: 'object' })).toBe('object');
    expect(deriveFieldKind({ type: 'array' })).toBe('array');
  });

  it('prefers a constrained choice over the underlying type', () => {
    expect(deriveFieldKind({ type: 'string', enum: ['a', 'b'] })).toBe('enum');
    expect(deriveFieldKind({ const: 'fixed' })).toBe('enum');
  });

  it('takes the first non-null member of a union type (the nullable-string shape)', () => {
    expect(deriveFieldKind({ type: ['null', 'string'] })).toBe('string');
  });

  it('infers a shape when `type` is absent, and gives up honestly otherwise', () => {
    expect(deriveFieldKind({ properties: { a: {} } })).toBe('object');
    expect(deriveFieldKind({ items: { type: 'string' } })).toBe('array');
    expect(deriveFieldKind({ $ref: './decimal' })).toBe('unknown');
  });
});

describe('buildTestField', () => {
  it('projects an object into one child per property, carrying required and constraints', () => {
    const field = buildTestField(MONEY_SCHEMA, { label: 'money' });

    expect(field.kind).toBe('object');
    expect(field.children?.map((child) => child.key)).toEqual(['amount', 'currency', 'note']);

    const amount = field.children?.find((child) => child.key === 'amount');
    expect(amount?.required).toBe(true);
    expect(amount?.pattern).toBe('^[0-9]+\\.[0-9]{2}$');

    expect(field.children?.find((child) => child.key === 'note')?.required).toBe(false);
  });

  it('projects a scalar schema as a single field', () => {
    const field = buildTestField({ type: 'string', format: 'email' });
    expect(field.kind).toBe('string');
    expect(field.format).toBe('email');
    expect(field.children).toBeUndefined();
  });

  it('projects an array through its item schema', () => {
    const field = buildTestField({ type: 'array', items: { type: 'integer' } });
    expect(field.kind).toBe('array');
    expect(field.item?.kind).toBe('integer');
  });

  it('projects a tuple from its first prefixItems entry', () => {
    const field = buildTestField({ type: 'array', prefixItems: [{ type: 'boolean' }, { type: 'string' }] });
    expect(field.item?.kind).toBe('boolean');
  });

  it('flags a $ref it cannot resolve rather than pretending the node is typed', () => {
    const field = buildTestField({ type: 'object', properties: { a: { $ref: './decimal' } } });
    const child = field.children?.[0];
    expect(child?.unresolvedRef).toBe('./decimal');
    expect(child?.kind).toBe('unknown');
  });

  it('treats a local $ref as resolvable (Ajv handles it) and does not flag it', () => {
    const field = buildTestField({ type: 'object', properties: { a: { $ref: '#/$defs/x' } } });
    expect(field.children?.[0]?.unresolvedRef).toBeUndefined();
  });

  it('stops expanding at the depth guard so a cyclic schema cannot run away', () => {
    // Nest objects well past the limit.
    let schema: Record<string, unknown> = { type: 'string' };
    for (let i = 0; i < MAX_FORM_DEPTH + 3; i += 1) {
      schema = { type: 'object', properties: { next: schema } };
    }
    const field = buildTestField(schema);

    let node = field;
    let depth = 0;
    while (node.children?.[0]) {
      node = node.children[0];
      depth += 1;
    }
    expect(depth).toBeLessThanOrEqual(MAX_FORM_DEPTH);
  });
});

describe('pointer helpers', () => {
  it('escapes RFC 6901 reserved characters', () => {
    expect(escapePointerToken('a/b')).toBe('a~1b');
    expect(escapePointerToken('a~b')).toBe('a~0b');
    expect(childPointer('', 'amount')).toBe('/amount');
    expect(childPointer('/a', 'b')).toBe('/a/b');
  });
});

describe('coerceScalar', () => {
  const numberField = buildTestField({ type: 'number' });
  const integerField = buildTestField({ type: 'integer' });
  const boolField = buildTestField({ type: 'boolean' });
  const unknownField = buildTestField({ $ref: './decimal' });

  it('reads numbers, and reports text that is not one', () => {
    expect(coerceScalar(numberField, '12.5')).toEqual({ value: 12.5 });
    expect(coerceScalar(numberField, 'abc').error).toMatch(/not a number/i);
    expect(coerceScalar(numberField, '').error).toMatch(/enter a number/i);
  });

  it('leaves a non-integer number to the schema so the reader sees the real type error', () => {
    expect(coerceScalar(integerField, '1.5')).toEqual({ value: 1.5 });
  });

  it('reads booleans from the select value', () => {
    expect(coerceScalar(boolField, 'true')).toEqual({ value: true });
    expect(coerceScalar(boolField, 'false')).toEqual({ value: false });
  });

  it('parses raw JSON for untyped nodes and reports malformed input', () => {
    expect(coerceScalar(unknownField, '{"a":1}')).toEqual({ value: { a: 1 } });
    expect(coerceScalar(unknownField, '{oops').error).toMatch(/valid JSON/i);
  });

  it('maps an enum selection back to its typed value', () => {
    const enumField = buildTestField({ enum: [1, 2, 3] });
    expect(coerceScalar(enumField, '2')).toEqual({ value: 2 });
  });
});

describe('buildInstance', () => {
  const field = buildTestField(MONEY_SCHEMA);

  it('includes required properties by default and omits optional ones', () => {
    const state = emptyState();
    state.values['/amount'] = '10.00';
    state.values['/currency'] = 'USD';

    expect(buildInstance(field, state)).toEqual({ amount: '10.00', currency: 'USD' });
  });

  it('honours an explicit include toggle in both directions', () => {
    const state = emptyState();
    state.values['/amount'] = '10.00';
    state.values['/currency'] = 'USD';
    state.values['/note'] = 'hello';
    state.included['/note'] = true;
    state.included['/currency'] = false;

    expect(buildInstance(field, state)).toEqual({ amount: '10.00', note: 'hello' });
  });

  it('builds an array of the item shape, defaulting to one element', () => {
    const arrayField = buildTestField({ type: 'array', items: { type: 'string' } });
    const state = emptyState();
    state.values['/0'] = 'first';

    expect(buildInstance(arrayField, state)).toEqual(['first']);

    state.arrayLengths[''] = 2;
    state.values['/1'] = 'second';
    expect(buildInstance(arrayField, state)).toEqual(['first', 'second']);
  });
});

describe('isIncluded / arrayLength defaults', () => {
  it('defaults inclusion to the field requiredness, and array length to one', () => {
    const field = buildTestField(MONEY_SCHEMA);
    const amount = field.children!.find((c) => c.key === 'amount')!;
    const note = field.children!.find((c) => c.key === 'note')!;

    expect(isIncluded(emptyState(), '/amount', amount)).toBe(true);
    expect(isIncluded(emptyState(), '/note', note)).toBe(false);
    expect(arrayLength(emptyState(), '')).toBe(1);
  });
});

describe('patternMatches', () => {
  it('applies the regex with JSON Schema (unanchored ECMA-262) semantics', () => {
    expect(patternMatches('^[0-9]+$', '123')).toBe(true);
    expect(patternMatches('^[0-9]+$', '12a')).toBe(false);
    // Unanchored patterns match anywhere in the string.
    expect(patternMatches('[0-9]+', 'abc123')).toBe(true);
  });

  it('reports a pattern this engine cannot compile instead of throwing', () => {
    expect(patternMatches('(unclosed', 'anything')).toBeNull();
  });
});

describe('sanitizeForValidation', () => {
  it('drops references Ajv cannot resolve, keeps local ones, and reports what it removed', () => {
    const { schema, unresolvedRefs } = sanitizeForValidation({
      type: 'object',
      properties: {
        a: { $ref: './decimal', description: 'kept' },
        b: { $ref: '#/$defs/local' },
      },
    });

    const properties = (schema as { properties: Record<string, Record<string, unknown>> }).properties;
    expect(properties.a.$ref).toBeUndefined();
    // Sibling keywords survive — only the reference itself is stripped.
    expect(properties.a.description).toBe('kept');
    expect(properties.b.$ref).toBe('#/$defs/local');
    expect(unresolvedRefs).toEqual(['./decimal']);
  });
});

describe('compileTestValidator', () => {
  it('validates a conforming instance', () => {
    const validator = compileTestValidator(MONEY_SCHEMA);
    expect(validator.validate({ amount: '10.00', currency: 'USD' })).toEqual({ status: 'valid', findings: [] });
  });

  it('anchors each violation to the property it concerns', () => {
    const validator = compileTestValidator(MONEY_SCHEMA);
    const result = validator.validate({ amount: 'nope', currency: 'US' });

    expect(result.status).toBe('invalid');
    const byPointer = findingsByPointer(result.findings);
    expect(byPointer.get('/amount')?.[0].keyword).toBe('pattern');
    expect(byPointer.get('/currency')?.[0].keyword).toBe('minLength');
  });

  it('re-points a missing required property onto that property, not its parent', () => {
    const validator = compileTestValidator(MONEY_SCHEMA);
    const result = validator.validate({ currency: 'USD' });

    const byPointer = findingsByPointer(result.findings);
    expect(byPointer.get('/amount')?.[0].keyword).toBe('required');
  });

  it('still validates a type whose $ref cannot be resolved, and says which one it dropped', () => {
    const validator = compileTestValidator({
      type: 'object',
      properties: { amount: { $ref: './decimal' }, currency: { type: 'string', minLength: 3 } },
      required: ['amount', 'currency'],
    });

    expect(validator.schemaError).toBeUndefined();
    expect(validator.unresolvedRefs).toEqual(['./decimal']);
    // The local constraint is still enforced...
    expect(validator.validate({ amount: 'anything', currency: 'US' }).status).toBe('invalid');
    // ...and the unresolved node accepts any value rather than failing closed.
    expect(validator.validate({ amount: { any: 'shape' }, currency: 'USD' }).status).toBe('valid');
  });

  it('wraps the schema in an array for array test mode', () => {
    const validator = compileTestValidator({ type: 'string', minLength: 2 }, true);

    expect(validator.validate(['ab', 'cd']).status).toBe('valid');
    const result = validator.validate(['ab', 'x']);
    expect(result.status).toBe('invalid');
    expect(result.findings[0].pointer).toBe('/1');
  });

  it('degrades to `unavailable` rather than throwing when the schema will not compile', () => {
    const validator = compileTestValidator({ type: 'string', pattern: '(' });
    expect(validator.validate('anything').status).toBe('unavailable');
    expect(validator.schemaError).toBeTruthy();
  });
});

describe('seedStateFromInstance', () => {
  it('fills raw text and inclusions from a generated example', () => {
    const field = buildTestField(MONEY_SCHEMA);
    const state = seedStateFromInstance(field, { amount: '10.00', currency: 'USD' });

    expect(state.values['/amount']).toBe('10.00');
    expect(state.values['/currency']).toBe('USD');
    expect(state.included['/amount']).toBe(true);
    // Absent from the example → not force-included.
    expect(state.included['/note']).toBeUndefined();
  });

  it('records array lengths so the seeded form shows every example element', () => {
    const field = buildTestField({ type: 'array', items: { type: 'string' } });
    const state = seedStateFromInstance(field, ['a', 'b', 'c']);

    expect(state.arrayLengths['']).toBe(3);
    expect(state.values['/2']).toBe('c');
  });
});
