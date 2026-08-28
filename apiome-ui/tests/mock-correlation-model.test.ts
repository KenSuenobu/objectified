/**
 * The rules behind the correlation editor and the shared mock authoring helpers (#5529, MSC-1.3).
 *
 * These are the parts a rendered dialog cannot pin: that a mode's copy exists for every mode, that
 * a draft round-trips through the wire shape without losing a binding, that the MSC-1.1 contract
 * ("bindings saved with mode off are refused, not silently dropped") is enforced before the request
 * is even made, and — the acceptance criterion this ticket turns on — that a REST 422 lands on the
 * row that caused it instead of in a list detached from the fields.
 */

import {
  attachServerErrors,
  blockErrors,
  CORRELATION_MODE_COPY,
  CORRELATION_MODES,
  draftFromPayload,
  draftIsEmpty,
  errorsForRow,
  isInferenceMode,
  payloadFromDraft,
  validateBindingRow,
  type CorrelationDraft,
} from '../src/app/components/ade/dashboard/mock/correlationEditorModel';
import {
  buildTokenGroups,
  escapePointerSegment,
  formatPreviewBody,
  insertToken,
  previewRequestFromDraft,
  sampleRequestForOperation,
  traceLayerIsProblem,
  traceLayerLabel,
  type MockAuthoringOperation,
} from '../src/app/components/ade/dashboard/mock/mockAuthoringModel';

const GET_PET: MockAuthoringOperation = {
  key: 'GET /pets/{petId}',
  method: 'GET',
  path: '/pets/{petId}',
  summary: 'Fetch one pet',
  parameters: [
    { name: 'petId', location: 'path', required: true, type: 'integer', token: '{{request.path.petId}}' },
    { name: 'expand', location: 'query', required: false, type: 'string', token: '{{request.query.expand}}' },
    { name: 'X-Tier', location: 'header', required: true, type: 'string', token: '{{request.header.X-Tier}}' },
  ],
  requestFields: [],
  responsePointers: [{ pointer: '/id', type: 'integer', repeated: false }],
  successStatus: 200,
  bindings: [{ pointer: '/id', source: '{{request.path.petId}}', pass: 'path-params', repeated: false }],
};

const CREATE_PET: MockAuthoringOperation = {
  key: 'POST /pets',
  method: 'POST',
  path: '/pets',
  summary: 'Create a pet',
  parameters: [],
  requestFields: ['name', 'tag'],
  responsePointers: [{ pointer: '/name', type: 'string', repeated: false }],
  successStatus: 201,
  bindings: [{ pointer: '/name', source: '{{request.body#/name}}', pass: 'inferred', repeated: false }],
};

describe('correlation mode copy', () => {
  it('describes every mode in terms of what a response does', () => {
    for (const mode of CORRELATION_MODES) {
      const copy = CORRELATION_MODE_COPY[mode];
      expect(copy.label).toBeTruthy();
      expect(copy.description.length).toBeGreaterThan(20);
    }
  });

  it('marks exactly the two inference modes as inferring', () => {
    const inferring = CORRELATION_MODES.filter((mode) => CORRELATION_MODE_COPY[mode].infers);
    expect(inferring).toEqual(['path-params', 'inferred']);
    // The copy flag and the type guard the bindings preview is gated on must agree.
    expect(CORRELATION_MODES.filter(isInferenceMode)).toEqual(inferring);
  });
});

describe('draft ⇄ wire shape', () => {
  it('flattens the stored pointer map into rows in stored order', () => {
    const draft = draftFromPayload({
      mode: 'explicit',
      operations: {
        'GET /pets/{petId}': { '/id': '{{request.path.petId}}', '/ref': '{{request.query.ref}}' },
      },
    });

    expect(draft.mode).toBe('explicit');
    expect(draft.bindings).toEqual([
      { operationKey: 'GET /pets/{petId}', pointer: '/id', expression: '{{request.path.petId}}' },
      { operationKey: 'GET /pets/{petId}', pointer: '/ref', expression: '{{request.query.ref}}' },
    ]);
  });

  it('treats a missing block as correlation off', () => {
    expect(draftFromPayload(null)).toEqual({ mode: 'off', bindings: [] });
    expect(draftIsEmpty(draftFromPayload(null))).toBe(true);
  });

  it('nests rows back under their operation', () => {
    const draft: CorrelationDraft = {
      mode: 'inferred',
      bindings: [
        { operationKey: 'GET /pets/{petId}', pointer: '/id', expression: '{{request.path.petId}}' },
        { operationKey: 'GET /pets/{petId}', pointer: '/ref', expression: '{{request.query.ref}}' },
        { operationKey: 'POST /pets', pointer: '/name', expression: '{{request.body#/name}}' },
      ],
    };

    const { payload, errors } = payloadFromDraft(draft);

    expect(errors).toEqual([]);
    expect(payload).toEqual({
      mode: 'inferred',
      operations: {
        'GET /pets/{petId}': { '/id': '{{request.path.petId}}', '/ref': '{{request.query.ref}}' },
        'POST /pets': { '/name': '{{request.body#/name}}' },
      },
    });
  });

  it('reports a row an author added and never filled in, rather than dropping it', () => {
    // Silently discarding a row someone deliberately added is the same class of quiet no-op
    // MSC-1.1 already refused for `mode: "off"`.
    const { payload, errors } = payloadFromDraft({
      mode: 'path-params',
      bindings: [{ operationKey: '', pointer: '', expression: '' }],
    });

    expect(payload).toBeNull();
    expect(errorsForRow(errors, 0)).toHaveLength(3);
  });

  it('lets the preview render past a row that is still being filled in', () => {
    const { payload, errors } = payloadFromDraft(
      { mode: 'path-params', bindings: [{ operationKey: '', pointer: '', expression: '' }] },
      { ignoreBlankRows: true }
    );

    expect(errors).toEqual([]);
    expect(payload).toEqual({ mode: 'path-params', operations: {} });
  });
});

describe('row validation', () => {
  it('names each missing piece', () => {
    expect(validateBindingRow({ operationKey: '', pointer: '', expression: '' })).toHaveLength(3);
  });

  it('rejects a pointer that is not one', () => {
    const messages = validateBindingRow({
      operationKey: 'GET /pets/{petId}',
      pointer: 'id',
      expression: '{{request.path.petId}}',
    });

    expect(messages).toEqual([expect.stringContaining('must start with "/"')]);
  });

  it('points out an expression that binds a constant', () => {
    const messages = validateBindingRow({
      operationKey: 'GET /pets/{petId}',
      pointer: '/id',
      expression: '42',
    });

    expect(messages).toEqual([expect.stringContaining('{{request.path.petId}}')]);
  });

  it('reports a duplicate pointer against the second row', () => {
    const { payload, errors } = payloadFromDraft({
      mode: 'explicit',
      bindings: [
        { operationKey: 'GET /pets/{petId}', pointer: '/id', expression: '{{request.path.petId}}' },
        { operationKey: 'GET /pets/{petId}', pointer: '/id', expression: '{{random.uuid()}}' },
      ],
    });

    expect(payload).toBeNull();
    expect(errors).toEqual([{ row: 1, message: expect.stringContaining('already binds /id') }]);
  });

  it('refuses bindings saved with correlation off, and says which mode keeps them', () => {
    // MSC-1.1's contract: the runtime drops the whole block when the mode is off, so REST answers
    // 422 rather than storing bindings that could never run. The editor must not send it at all.
    const { payload, errors } = payloadFromDraft({
      mode: 'off',
      bindings: [{ operationKey: 'GET /pets/{petId}', pointer: '/id', expression: '{{request.path.petId}}' }],
    });

    expect(payload).toBeNull();
    expect(blockErrors(errors)).toEqual([
      { row: null, message: expect.stringContaining('Only my bindings') },
    ]);
  });
});

describe('server errors land on the offending row', () => {
  const bindings = [
    { operationKey: 'GET /pets/{petId}', pointer: '/id', expression: '{{request.path.petId}}' },
    { operationKey: 'GET /pets/{petId}', pointer: '/ref', expression: '{{request.query.ref' },
    { operationKey: 'POST /pets', pointer: '/name', expression: '{{request.body#/name}}' },
  ];

  it('matches on the operation and the pointer REST names', () => {
    const attached = attachServerErrors(
      [
        "Correlation, operation 'GET /pets/{petId}', pointer '/ref': unterminated expression.",
        "Correlation, operation 'POST /pets': no operation POST /pets exists in this version's spec.",
      ],
      bindings
    );

    expect(attached[0].row).toBe(1);
    expect(attached[1].row).toBe(2);
    expect(errorsForRow(attached, 1)).toHaveLength(1);
  });

  it('keeps a message that names no row at block level rather than guessing', () => {
    const attached = attachServerErrors(
      ['Correlation: the correlation block is too large (70000 bytes; max 65536).'],
      bindings
    );

    expect(attached).toEqual([{ row: null, message: expect.stringContaining('too large') }]);
    expect(blockErrors(attached)).toHaveLength(1);
  });

  it('falls back to block level when the named operation is no longer on screen', () => {
    const attached = attachServerErrors(
      ["Correlation, operation 'DELETE /pets/{petId}': no operation exists."],
      bindings
    );

    expect(attached[0].row).toBeNull();
  });
});

describe('token groups', () => {
  it('offers only what the selected operation and version actually have', () => {
    const groups = buildTokenGroups(GET_PET, ['pets']);
    const titles = groups.map((group) => group.title);

    expect(titles).toEqual([
      'Path parameters',
      'Query parameters',
      'Headers',
      'Fixtures',
      'Request facts & seeded values',
    ]);
    expect(groups[0].tokens[0].token).toBe('{{request.path.petId}}');
    expect(groups[3].tokens[0].token).toBe('{{fixture.pets}}');
  });

  it('offers request-body fields only on a method that carries one', () => {
    const write = buildTokenGroups(CREATE_PET, []);
    expect(write.find((group) => group.title === 'Request body')?.tokens).toEqual([
      { token: '{{request.body#/name}}', label: 'name', hint: expect.any(String) },
      { token: '{{request.body#/tag}}', label: 'tag', hint: expect.any(String) },
    ]);

    expect(buildTokenGroups(GET_PET, []).some((group) => group.title === 'Request body')).toBe(false);
  });

  it('still offers the seeded values with no operation selected', () => {
    expect(buildTokenGroups(null, [])).toEqual([
      { title: 'Request facts & seeded values', tokens: expect.any(Array) },
    ]);
  });

  it('escapes a field name that would break the pointer', () => {
    expect(escapePointerSegment('a/b~c')).toBe('a~1b~0c');
  });
});

describe('inserting a token', () => {
  it('replaces the selection and reports where the caret goes', () => {
    expect(insertToken('{"id": ""}', '{{request.path.petId}}', 8, 8)).toEqual({
      value: '{"id": "{{request.path.petId}}"}',
      caret: 30,
    });
  });

  it('appends when there is no caret', () => {
    expect(insertToken('abc', 'X', null, null)).toEqual({ value: 'abcX', caret: 4 });
  });
});

describe('sample requests', () => {
  it('substitutes path parameters so the request actually routes', () => {
    const draft = sampleRequestForOperation(GET_PET);

    expect(draft.method).toBe('GET');
    expect(draft.path).toBe('/pets/42');
    // Required parameters are prefilled; optional ones are left for the author to add.
    expect(JSON.parse(draft.headersText)).toEqual({ 'X-Tier': 'sample' });
    expect(draft.queryText).toBe('');
  });

  it('prefills a body from the request fields on a write', () => {
    expect(JSON.parse(sampleRequestForOperation(CREATE_PET).bodyText)).toEqual({
      name: 'sample',
      tag: 'sample',
    });
  });

  it('falls back to GET / with no operation', () => {
    expect(sampleRequestForOperation(null)).toEqual({
      method: 'GET',
      path: '/',
      headersText: '',
      queryText: '',
      bodyText: '',
    });
  });
});

describe('the synthetic request', () => {
  it('builds the payload the preview endpoint accepts', () => {
    const parsed = previewRequestFromDraft({
      method: 'post',
      path: '/pets',
      headersText: '{"X-Tier": "gold"}',
      queryText: '{"limit": 10}',
      bodyText: '{"name": "Rex"}',
    });

    expect(parsed.errors).toEqual([]);
    expect(parsed.request).toEqual({
      method: 'POST',
      path: '/pets',
      headers: { 'X-Tier': 'gold' },
      query: { limit: '10' },
      body: { name: 'Rex' },
    });
  });

  it('refuses a path that is not relative to the version root', () => {
    const parsed = previewRequestFromDraft({
      method: 'GET',
      path: 'pets/42',
      headersText: '',
      queryText: '',
      bodyText: '',
    });

    expect(parsed.request).toBeUndefined();
    expect(parsed.errors).toEqual([expect.stringContaining('must start with "/"')]);
  });

  it('reports every unparseable field at once', () => {
    const parsed = previewRequestFromDraft({
      method: 'GET',
      path: '/pets',
      headersText: '[]',
      queryText: 'nope',
      bodyText: '{',
    });

    expect(parsed.errors).toHaveLength(3);
  });
});

describe('trace copy', () => {
  it('names every layer the preview can report', () => {
    expect(traceLayerLabel('correlation')).toBe('Correlation');
    expect(traceLayerLabel('forced-status')).toBe('Forced status');
    // A layer added on the runtime side later still renders, rather than disappearing.
    expect(traceLayerLabel('something-new')).toBe('something-new');
  });

  it('separates a rendered answer from a refusal', () => {
    expect(traceLayerIsProblem('correlation')).toBe(false);
    expect(traceLayerIsProblem('no-operation')).toBe(true);
  });

  it('formats each body encoding', () => {
    expect(formatPreviewBody({ id: 1 }, 'json')).toBe('{\n  "id": 1\n}');
    expect(formatPreviewBody('hello', 'text')).toBe('hello');
    expect(formatPreviewBody(null, 'empty')).toBe('');
  });
});
