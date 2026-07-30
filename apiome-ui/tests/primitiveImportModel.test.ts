/**
 * Tests for the Primitives import wizard model (#3469).
 *
 * Exercises the pure parsing / request-building / review helpers that back the wizard so the
 * source -> review -> commit flow stays aligned with the REST import pipeline contract.
 */

import {
  parseSchemaContent,
  isSchemaDocument,
  isStandalonePrimitiveSchema,
  extractPrimitiveNameFromSchema,
  determineCategoryFromSchema,
  extractDefinitions,
  describeDetectedTypes,
  untypedSchemaWarning,
  countCautionedTypes,
  UNTYPED_SCHEMA_WARNING,
  extractTargetNamespace,
  buildImportRequestBody,
  filterResolutions,
  defaultResolutions,
  defaultSelectedNames,
  validateSelection,
  summarizeImportResult,
  describeImportResult,
  sourceKindLabel,
  type ImportOptions,
  type ReviewType,
} from '../src/app/ade/dashboard/primitives/primitiveImportModel';

const baseOptions: ImportOptions = {
  sourceKind: 'json-schema',
  targetNamespace: '',
  mapCoreFormats: true,
  dedupe: true,
};

const reviewType = (overrides: Partial<ReviewType>): ReviewType => ({
  name: 'Type',
  status: 'new',
  valid: true,
  validation_errors: [],
  error: null,
  schema_id: null,
  existing_id: null,
  ref_count: 0,
  unresolved_refs: [],
  allowed_resolutions: [],
  ...overrides,
});

describe('parseSchemaContent', () => {
  it('parses JSON', () => {
    expect(parseSchemaContent('{"a":1}')).toEqual({ a: 1 });
  });

  it('falls back to YAML', () => {
    const parsed = parseSchemaContent('$defs:\n  Email:\n    type: string');
    expect((parsed?.$defs as Record<string, unknown>).Email).toEqual({ type: 'string' });
  });

  it('returns null for non-object content', () => {
    expect(parseSchemaContent('"just a string"')).toBeNull();
    expect(parseSchemaContent('42')).toBeNull();
  });

  it('returns null for unparseable content', () => {
    expect(parseSchemaContent('not: : valid: yaml: {')).toBeNull();
  });
});

describe('isStandalonePrimitiveSchema', () => {
  it('treats a bare type as standalone', () => {
    expect(isStandalonePrimitiveSchema({ type: 'string' })).toBe(true);
    expect(isStandalonePrimitiveSchema({ enum: ['a', 'b'] })).toBe(true);
    expect(isStandalonePrimitiveSchema({ anyOf: [{ const: 'a' }] })).toBe(true);
  });

  it('treats a container as not standalone', () => {
    expect(isStandalonePrimitiveSchema({ $defs: { A: {} } })).toBe(false);
    expect(isStandalonePrimitiveSchema({ definitions: { A: {} } })).toBe(false);
    expect(isStandalonePrimitiveSchema({ types: { A: {} } })).toBe(false);
  });

  it('returns false for a schema with no type indicators', () => {
    expect(isStandalonePrimitiveSchema({ properties: {} })).toBe(false);
  });
});

describe('extractPrimitiveNameFromSchema', () => {
  it('prefers the last $id segment', () => {
    expect(extractPrimitiveNameFromSchema({ $id: 'https://x/iso/percentage', title: 'P' })).toBe('percentage');
  });

  it('slugifies the title when there is no $id, keeping its structure', () => {
    // Hyphen-separated like the registry's own slug, and the digit groups stay separated rather
    // than being jammed together as `8000012022`.
    expect(extractPrimitiveNameFromSchema({ title: 'ISO 80000-1:2022 Percentage' })).toBe(
      'iso-80000-1-2022-percentage'
    );
  });

  it('falls back to the filename, preserving its hyphens', () => {
    expect(extractPrimitiveNameFromSchema({ type: 'string' }, 'my-type.json')).toBe('my-type');
  });

  it('uses a stable default', () => {
    expect(extractPrimitiveNameFromSchema({ type: 'object' })).toBe('imported-primitive');
  });

  describe('a hyphen in the name is preserved — it is url-safe', () => {
    it('keeps the hyphen in an $id leaf', () => {
      // The reported bug: `output-error` was imported as `output_error`, so the stored name no
      // longer matched the `$id` the registry serves the schema under.
      expect(
        extractPrimitiveNameFromSchema({ $id: 'https://api.apiome.dev/types/std/v0/types/output-error' })
      ).toBe('output-error');
    });

    it('keeps the hyphen in a filename', () => {
      expect(extractPrimitiveNameFromSchema({ type: 'object' }, 'output-error.json')).toBe(
        'output-error'
      );
    });

    it('keeps the hyphen coming from a title', () => {
      expect(extractPrimitiveNameFromSchema({ title: 'output-error' })).toBe('output-error');
    });

    it('never emits an underscore separator for a hyphenated source', () => {
      for (const schema of [
        { $id: 'https://x/output-error' },
        { title: 'Output-Error' },
      ]) {
        expect(extractPrimitiveNameFromSchema(schema)).not.toContain('_');
      }
    });

    it('takes an $id leaf verbatim rather than re-slugging it', () => {
      // An `$id` leaf is already canonical; an underscore an author chose is theirs to keep.
      expect(extractPrimitiveNameFromSchema({ $id: 'https://x/legacy_name' })).toBe('legacy_name');
    });

    it('percent-decodes an $id leaf', () => {
      expect(extractPrimitiveNameFromSchema({ $id: 'https://x/output%2Derror' })).toBe('output-error');
    });

    it('ignores a trailing slash on the $id', () => {
      expect(extractPrimitiveNameFromSchema({ $id: 'https://x/types/output-error/' })).toBe(
        'output-error'
      );
    });
  });

  describe('agrees with the server, which derives the same name for the same document', () => {
    // Mirrors `_root_definition_name` in apiome-rest/src/app/primitives_routes.py: when the
    // wizard sends a root-plus-$defs document as-is, the name shown in the preview has to be
    // the one the review comes back with, or the user's selection cannot be matched to it.
    it('drops a .json / .schema.json suffix from an $id leaf', () => {
      expect(extractPrimitiveNameFromSchema({ $id: 'https://acme.test/user.schema.json' })).toBe(
        'user'
      );
      expect(extractPrimitiveNameFromSchema({ $id: 'https://acme.test/list/response.json' })).toBe(
        'response'
      );
    });

    it('ignores a fragment on the $id', () => {
      expect(extractPrimitiveNameFromSchema({ $id: 'https://x/types/money#/$defs/a' })).toBe(
        'money'
      );
    });

    it('reads the last path segment when the source label is a URL, not a filename', () => {
      expect(
        extractPrimitiveNameFromSchema(
          { type: 'object' },
          'https://schemas.sourcemeta.com/self/v1/schemas/api/list/response.json?v=2'
        )
      ).toBe('response');
    });
  });
});

describe('determineCategoryFromSchema', () => {
  it('reads an explicit type', () => {
    expect(determineCategoryFromSchema({ type: 'number' })).toBe('number');
    expect(determineCategoryFromSchema({ type: ['string', 'null'] })).toBe('string');
  });

  it('infers from anyOf consts', () => {
    expect(determineCategoryFromSchema({ anyOf: [{ const: 'a' }] })).toBe('string');
    expect(determineCategoryFromSchema({ anyOf: [{ const: 1 }] })).toBe('number');
  });

  it('infers from enum', () => {
    expect(determineCategoryFromSchema({ enum: ['a'] })).toBe('string');
  });

  it('defaults to object', () => {
    expect(determineCategoryFromSchema({ properties: {} })).toBe('object');
  });
});

describe('extractDefinitions', () => {
  it('reads $defs and definitions for JSON Schema', () => {
    const defs = extractDefinitions(
      { $defs: { Email: { type: 'string' } }, definitions: { Phone: { type: 'string' } } },
      'json-schema'
    );
    expect(Object.keys(defs).sort()).toEqual(['Email', 'Phone']);
  });

  it('reads the types container for a bundle', () => {
    const defs = extractDefinitions({ types: { Money: { type: 'object' } } }, 'type-def-bundle');
    expect(Object.keys(defs)).toEqual(['Money']);
  });

  it('wraps a standalone JSON Schema under a derived name', () => {
    const defs = extractDefinitions({ $id: 'https://x/email', type: 'string' }, 'json-schema');
    expect(Object.keys(defs)).toEqual(['email']);
  });

  it('does not treat a standalone document as a bundle member', () => {
    // A bundle is expected to be a container; a bare type yields no definitions.
    expect(extractDefinitions({ type: 'string' }, 'type-def-bundle')).toEqual({});
  });

  describe('a document is not only its $defs', () => {
    // The reported bug, reproducing
    // https://schemas.sourcemeta.com/self/v1/schemas/api/list/response.json: the document
    // declares an `$id`, a `type`, and `properties` of its own *and* carries `$defs` of the
    // sub-schemas it refs. Only `policies` was imported; `response` was silently dropped.
    const rootAndDefs = {
      $id: 'https://schemas.sourcemeta.com/self/v1/schemas/api/list/response',
      title: 'Sourcemeta One List API Response',
      type: 'object',
      properties: { policies: { $ref: '#/$defs/policies' } },
      $defs: { policies: { type: 'array' } },
    };

    it('reads the root schema alongside its $defs, root first', () => {
      expect(Object.keys(extractDefinitions(rootAndDefs, 'json-schema'))).toEqual([
        'response',
        'policies',
      ]);
    });

    it('strips the containers from the root, whose refs the API rewrites to siblings', () => {
      const root = extractDefinitions(rootAndDefs, 'json-schema').response;
      expect(root).not.toHaveProperty('$defs');
      expect(root.properties).toEqual({ policies: { $ref: '#/$defs/policies' } });
    });

    it('suffixes a root name that collides with one of its own definitions', () => {
      const defs = extractDefinitions(
        { $id: 'https://x/policies', type: 'object', $defs: { policies: { type: 'array' } } },
        'json-schema'
      );
      expect(Object.keys(defs)).toEqual(['policies-root', 'policies']);
    });

    it('adds no root for a document that asserts nothing about itself', () => {
      expect(Object.keys(extractDefinitions({ $defs: { A: { type: 'string' } } }, 'json-schema')))
        .toEqual(['A']);
    });

    it('reads only the container for a bundle, which is a container by definition', () => {
      expect(Object.keys(extractDefinitions(rootAndDefs, 'type-def-bundle'))).toEqual(['policies']);
    });
  });

  describe('a type need not constrain anything', () => {
    // https://schemas.sourcemeta.com/self/v1/schemas/api/schemas/evaluate/request.json: it
    // accepts *any* JSON instance, so it declares no `type` and no `properties` — only its
    // identity and documentation. It is the empty schema, and the document's only type.
    const annotationOnly = {
      $schema: 'https://json-schema.org/draft/2020-12/schema',
      $id: 'https://schemas.sourcemeta.com/self/v1/schemas/api/schemas/evaluate/request',
      title: 'Sourcemeta One Schema Evaluate API Request',
      description: 'The JSON instance to validate against a schema in the catalog',
      examples: [{ name: 'Alice' }, 'hello world', 42, true, null, [1, 2, 3]],
    };

    it('detects an annotation-only schema as one type, named from its $id', () => {
      const defs = extractDefinitions(annotationOnly, 'json-schema');
      expect(Object.keys(defs)).toEqual(['request']);
      expect(defs.request).toEqual(annotationOnly);
    });

    it('reports it as a valid draft 2020-12 schema, categorized object, with a caution', () => {
      const [detected] = describeDetectedTypes(extractDefinitions(annotationOnly, 'json-schema'));
      expect(detected).toEqual({
        name: 'request',
        valid: true,
        warning: UNTYPED_SCHEMA_WARNING,
      });
      expect(determineCategoryFromSchema(annotationOnly)).toBe('object');
    });

    it('detects nothing in arbitrary JSON that carries no JSON Schema keyword', () => {
      expect(extractDefinitions({ name: 'acme-tools', version: '1.4.0' }, 'json-schema')).toEqual(
        {}
      );
    });
  });
});

describe('isSchemaDocument', () => {
  it('is true for a document that asserts something about itself, container or not', () => {
    expect(isSchemaDocument({ type: 'object', $defs: { A: {} } })).toBe(true);
    expect(isSchemaDocument({ properties: {} })).toBe(true);
    expect(isSchemaDocument({ enum: ['a'] })).toBe(true);
  });

  it('is false for a container whose members are the types', () => {
    expect(isSchemaDocument({ $defs: { A: {} } })).toBe(false);
    // A titled, identified bundle is still a bundle — no junk empty root type.
    expect(isSchemaDocument({ $id: 'https://x/a', title: 'A', $defs: { A: {} } })).toBe(false);
  });

  it('is true for an annotation-only schema with no definitions to read instead', () => {
    // The empty schema constrains nothing; that is not a reason to refuse it.
    expect(isSchemaDocument({ $id: 'https://x/a', title: 'A' })).toBe(true);
    expect(isSchemaDocument({ description: 'anything' })).toBe(true);
  });

  it('is false for arbitrary JSON carrying no JSON Schema keyword', () => {
    expect(isSchemaDocument({ name: 'acme-tools', version: '1.4.0' })).toBe(false);
    expect(isSchemaDocument({ $defs: {} })).toBe(false);
  });
});

describe('describeDetectedTypes', () => {
  it('names every definition and marks well-formed schemas valid, in declaration order', () => {
    const result = describeDetectedTypes({
      money: { type: 'object', properties: { amount: { type: 'string' } } },
      decimal: { type: 'string', pattern: '^[0-9]+$' },
    });

    expect(result).toEqual([
      { name: 'money', valid: true },
      { name: 'decimal', valid: true },
    ]);
  });

  it('marks a malformed draft 2020-12 schema invalid and says why', () => {
    const [entry] = describeDetectedTypes({ broken: { type: 'not-a-type' } });

    expect(entry.name).toBe('broken');
    expect(entry.valid).toBe(false);
    expect(entry.error).toMatch(/\/type/);
  });

  it('catches a keyword of the wrong type', () => {
    const [entry] = describeDetectedTypes({ broken: { type: 'string', minLength: 'three' } });

    expect(entry.valid).toBe(false);
    expect(entry.error).toMatch(/minLength/);
  });

  it('keeps an unresolved $ref valid — resolution is not a metaschema question', () => {
    const [entry] = describeDetectedTypes({
      money: { type: 'object', properties: { amount: { $ref: './decimal' } } },
    });

    expect(entry.valid).toBe(true);
  });

  it('reports a non-object definition rather than throwing', () => {
    const result = describeDetectedTypes({
      nope: null as unknown as Record<string, unknown>,
      alsoNope: [] as unknown as Record<string, unknown>,
    });

    expect(result.every((entry) => !entry.valid)).toBe(true);
    expect(result[0].error).toMatch(/not a json schema object/i);
  });

  it('cautions an untyped definition while still calling it valid', () => {
    const [entry] = describeDetectedTypes({ request: { title: 'Request', examples: [42] } });

    expect(entry).toEqual({
      name: 'request',
      valid: true,
      warning: 'No type was specified in the JSON Schema: this might lead to erroneous behavior',
    });
  });

  it('carries the caution alongside a metaschema error', () => {
    // `required` must be an array; the definition still declares no type of its own.
    const [entry] = describeDetectedTypes({ broken: { required: 'name' } });

    expect(entry.valid).toBe(false);
    expect(entry.error).toMatch(/required/);
    expect(entry.warning).toBe(UNTYPED_SCHEMA_WARNING);
  });
});

describe('countCautionedTypes', () => {
  it('counts a type carrying an unresolved $ref', () => {
    expect(
      countCautionedTypes([
        reviewType({ name: 'position', unresolved_refs: [{ relative_ref: './missing' }] }),
        reviewType({ name: 'money' }),
      ]),
    ).toBe(1);
  });

  it('counts an advisory on the same axis as an unresolved ref', () => {
    expect(
      countCautionedTypes([reviewType({ name: 'request', warnings: [UNTYPED_SCHEMA_WARNING] })]),
    ).toBe(1);
  });

  it('counts a type once however many cautions it carries', () => {
    expect(
      countCautionedTypes([
        reviewType({
          name: 'both',
          warnings: [UNTYPED_SCHEMA_WARNING],
          unresolved_refs: [{ relative_ref: './a' }, { relative_ref: './b' }],
        }),
      ]),
    ).toBe(1);
  });

  it('is zero when nothing is cautioned, and tolerates a response missing the fields', () => {
    expect(countCautionedTypes([reviewType({ name: 'money' })])).toBe(0);
    const legacy = reviewType({ name: 'money' });
    delete (legacy as Partial<ReviewType>).warnings;
    delete (legacy as Partial<ReviewType>).unresolved_refs;
    expect(countCautionedTypes([legacy])).toBe(0);
  });
});

describe('untypedSchemaWarning', () => {
  it('fires for a definition that asserts nothing', () => {
    expect(untypedSchemaWarning({})).toBe(UNTYPED_SCHEMA_WARNING);
    expect(untypedSchemaWarning({ title: 'A', description: 'B' })).toBe(UNTYPED_SCHEMA_WARNING);
  });

  it('stays quiet whenever the shape can be read without a declared type', () => {
    // Not a guess: properties → object, enum → its values' type, $ref/combinator → elsewhere.
    expect(untypedSchemaWarning({ type: 'string' })).toBeUndefined();
    expect(untypedSchemaWarning({ properties: {} })).toBeUndefined();
    expect(untypedSchemaWarning({ enum: ['a'] })).toBeUndefined();
    expect(untypedSchemaWarning({ const: 1 })).toBeUndefined();
    expect(untypedSchemaWarning({ $ref: './money' })).toBeUndefined();
    expect(untypedSchemaWarning({ allOf: [{ type: 'string' }] })).toBeUndefined();
    expect(untypedSchemaWarning({ items: { type: 'string' } })).toBeUndefined();
  });

  it('returns nothing for a non-object definition', () => {
    expect(untypedSchemaWarning(null)).toBeUndefined();
    expect(untypedSchemaWarning([])).toBeUndefined();
    expect(untypedSchemaWarning('string')).toBeUndefined();
  });

  it('returns nothing for an empty container', () => {
    expect(describeDetectedTypes({})).toEqual([]);
  });
});

describe('extractTargetNamespace', () => {
  it('reads the namespace from the $id of a standalone schema', () => {
    const result = extractTargetNamespace(
      { $id: 'https://api.apiome.dev/types/tenant/acme/v1/types/money', type: 'object' },
      'json-schema'
    );

    expect(result.namespace).toBe('tenant/acme/v1/types');
    expect(result.detail).toMatch(/extracted tenant\/acme\/v1\/types/i);
  });

  it('reads it from the definitions of a container document', () => {
    const result = extractTargetNamespace(
      {
        $defs: {
          money: { $id: 'https://api.apiome.dev/types/std/v0/types/money', type: 'object' },
          decimal: { $id: 'https://api.apiome.dev/types/std/v0/types/decimal', type: 'string' },
        },
      },
      'json-schema'
    );

    expect(result.namespace).toBe('std/v0/types');
    expect(result.candidates).toEqual(['std/v0/types']);
  });

  it('reads a type-def bundle through its `types` container', () => {
    const result = extractTargetNamespace(
      { types: { charge: { $id: 'https://api.apiome.dev/types/tenant/acme/v2/payments/charge' } } },
      'type-def-bundle'
    );

    expect(result.namespace).toBe('tenant/acme/v2/payments');
  });

  it('picks the most frequent namespace and names the runners-up rather than hiding them', () => {
    const result = extractTargetNamespace(
      {
        $defs: {
          a: { $id: 'https://api.apiome.dev/types/std/v0/types/a' },
          b: { $id: 'https://api.apiome.dev/types/std/v0/types/b' },
          c: { $id: 'https://api.apiome.dev/types/tenant/acme/v1/types/c' },
        },
      },
      'json-schema'
    );

    expect(result.namespace).toBe('std/v0/types');
    expect(result.candidates).toEqual(['std/v0/types', 'tenant/acme/v1/types']);
    expect(result.detail).toMatch(/also declares tenant\/acme\/v1\/types/i);
  });

  it('prefers the document root id on a tie', () => {
    const result = extractTargetNamespace(
      {
        $id: 'https://api.apiome.dev/types/std/v0/types/bundle',
        $defs: { a: { $id: 'https://api.apiome.dev/types/tenant/acme/v1/types/a' } },
      },
      'json-schema'
    );

    expect(result.namespace).toBe('std/v0/types');
  });

  it('reads a foreign document’s own namespace, keeping every path segment', () => {
    const result = extractTargetNamespace(
      {
        $defs: {
          position: { $id: 'https://schemas.sourcemeta.com/self/v1/schemas/api/schemas/position' },
        },
      },
      'json-schema'
    );

    expect(result.namespace).toBe('self/v1/schemas/api/schemas');
  });

  it('reports that nothing was found when the ids are bare type names', () => {
    const result = extractTargetNamespace(
      { $defs: { a: { $id: 'https://x.example/a' } } },
      'json-schema'
    );

    expect(result.namespace).toBeNull();
    expect(result.detail).toMatch(/no namespace above the type name/i);
  });

  it('reports a document that declares no $id at all', () => {
    const result = extractTargetNamespace({ $defs: { a: { type: 'string' } } }, 'json-schema');

    expect(result.namespace).toBeNull();
    expect(result.detail).toMatch(/declares no \$id/i);
  });

  it('asks for a document when none is loaded', () => {
    const result = extractTargetNamespace(null, 'json-schema');

    expect(result.namespace).toBeNull();
    expect(result.detail).toMatch(/load a document first/i);
  });
});

describe('buildImportRequestBody', () => {
  it('builds a review body with import_all when no selection is given', () => {
    const body = buildImportRequestBody({ $defs: { A: { type: 'string' } } }, baseOptions, 'file.json');
    expect(body).toMatchObject({
      source_kind: 'json-schema',
      source_label: 'file.json',
      map_core_formats: true,
      dedupe: true,
      import_all: true,
    });
    expect(body.selected_definitions).toBeUndefined();
  });

  it('wraps a standalone schema in $defs', () => {
    const body = buildImportRequestBody({ $id: 'https://x/email', type: 'string' }, baseOptions, 'email');
    expect(body.schema).toEqual({ $defs: { email: { $id: 'https://x/email', type: 'string' } } });
  });

  it('sends a bundle document unwrapped', () => {
    const doc = { types: { Money: { type: 'object' } } };
    const body = buildImportRequestBody(doc, { ...baseOptions, sourceKind: 'type-def-bundle' }, 'bundle.json');
    expect(body.schema).toEqual(doc);
  });

  it('includes selection, resolutions, and namespace on commit', () => {
    const body = buildImportRequestBody(
      { $defs: { A: { type: 'string' }, B: { type: 'number' } } },
      { ...baseOptions, targetNamespace: ' acme/v1 ' },
      'file.json',
      { selectedNames: ['A', 'B'], resolutions: { A: { action: 'overwrite' } } }
    );
    expect(body.import_all).toBe(false);
    expect(body.selected_definitions).toEqual(['A', 'B']);
    expect(body.resolutions).toEqual({ A: { action: 'overwrite' } });
    expect(body.target_namespace).toBe('acme/v1');
  });

  it('omits an empty target namespace', () => {
    const body = buildImportRequestBody({ $defs: { A: {} } }, baseOptions, null);
    expect(body.target_namespace).toBeUndefined();
  });
});

describe('filterResolutions', () => {
  it('keeps only selected names and normalizes rename targets', () => {
    const out = filterResolutions(
      { A: { action: 'overwrite' }, B: { action: 'rename', new_name: ' b2 ' }, C: { action: 'keep' } },
      ['A', 'B']
    );
    expect(out).toEqual({ A: { action: 'overwrite' }, B: { action: 'rename', new_name: 'b2' } });
  });
});

describe('defaultResolutions / defaultSelectedNames', () => {
  const types = [
    reviewType({ name: 'New1', status: 'new' }),
    reviewType({ name: 'Conf1', status: 'conflict', allowed_resolutions: ['keep', 'overwrite', 'rename'] }),
    reviewType({ name: 'Same1', status: 'identical' }),
    reviewType({ name: 'Bad1', status: 'invalid', valid: false }),
  ];

  it('seeds keep for each conflict only', () => {
    expect(defaultResolutions(types)).toEqual({ Conf1: { action: 'keep' } });
  });

  it('selects new and conflict types by default', () => {
    expect(defaultSelectedNames(types).sort()).toEqual(['Conf1', 'New1']);
  });
});

describe('validateSelection', () => {
  const types = [
    reviewType({ name: 'New1', status: 'new' }),
    reviewType({ name: 'Conf1', status: 'conflict' }),
    reviewType({ name: 'Bad1', status: 'invalid', valid: false }),
  ];

  it('requires at least one selection', () => {
    expect(validateSelection([], types, {})).toMatch(/at least one/i);
  });

  it('rejects selecting an invalid type', () => {
    expect(validateSelection(['Bad1'], types, {})).toMatch(/not a valid/i);
  });

  it('requires a new name for a rename resolution', () => {
    expect(validateSelection(['Conf1'], types, { Conf1: { action: 'rename', new_name: '' } })).toMatch(/new name/i);
  });

  it('passes for a valid selection', () => {
    expect(validateSelection(['New1', 'Conf1'], types, { Conf1: { action: 'overwrite' } })).toBeNull();
  });

  it('ignores resolutions for unselected names', () => {
    expect(validateSelection(['New1'], types, { Conf1: { action: 'rename', new_name: '' } })).toBeNull();
  });
});

describe('summarizeImportResult / describeImportResult', () => {
  it('normalizes the REST report into stable arrays', () => {
    const result = summarizeImportResult({
      imported: ['A', 'B'],
      overwritten: ['C'],
      renamed: [{ name: 'D', new_name: 'D2' }],
      identical: ['E'],
      skipped: [{ name: 'F', reason: 'kept' }],
      errors: [{ name: 'G', error: 'boom' }],
      warnings: ['w'],
      import_id: 'imp-1',
    });
    expect(result.imported).toEqual(['A', 'B']);
    expect(result.overwritten).toEqual(['C']);
    expect(result.importId).toBe('imp-1');
  });

  it('defaults missing fields to empty arrays', () => {
    const result = summarizeImportResult({ imported: ['A'] });
    expect(result.overwritten).toEqual([]);
    expect(result.importId).toBeNull();
  });

  it('describes the outcome', () => {
    const result = summarizeImportResult({ imported: ['A', 'B'], overwritten: ['C'], errors: [{ name: 'G' }] });
    expect(describeImportResult(result)).toBe('Imported 2, overwritten 1, 1 error(s)');
  });
});

describe('sourceKindLabel', () => {
  it('labels each kind', () => {
    expect(sourceKindLabel('json-schema')).toBe('JSON Schema');
    expect(sourceKindLabel('type-def-bundle')).toBe('Type-def bundle');
    expect(sourceKindLabel('openapi')).toBe('OpenAPI');
  });
});
