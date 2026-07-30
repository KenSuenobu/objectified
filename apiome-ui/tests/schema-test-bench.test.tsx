/**
 * SchemaTestBench component tests (IXH-5.3, #5115).
 *
 * Walks the bench's acceptance criteria end to end against mocked fetch + Monaco:
 * schema selection across all three sources (+ the XML document entry), validation with
 * path-anchored inline markers and clickable findings, one-click loading of the synthetic
 * sets with the label preserved, tenant-scoped saved payloads, the copy-as-curl /
 * copy-as-fixture exports, the IXH-3.6 payload bound, and an axe pass over the whole panel.
 *
 * Monaco is stubbed with a textarea-backed harness so typing, marker application
 * (`setModelMarkers`), and reveal calls assert against jest spies.
 */

jest.mock('@monaco-editor/react', () => {
  const React = jest.requireActual<typeof import('react')>('react');
  const model = { isDisposed: () => false };
  const editor = {
    getModel: () => model,
    revealLineInCenter: jest.fn(),
    setPosition: jest.fn(),
    focus: jest.fn(),
  };
  const monaco = { editor: { setModelMarkers: jest.fn() } };
  const harness = {
    editor,
    monaco,
    reset: () => {
      editor.revealLineInCenter.mockClear();
      editor.setPosition.mockClear();
      editor.focus.mockClear();
      monaco.editor.setModelMarkers.mockClear();
    },
  };
  function MockMonaco(props: {
    value?: string;
    language?: string;
    onChange?: (value: string | undefined) => void;
    onMount?: (ed: typeof editor, m: typeof monaco) => void;
  }) {
    React.useEffect(() => {
      props.onMount?.(editor, monaco);
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);
    return (
      <textarea
        data-testid="mock-monaco"
        aria-label="Payload editor"
        data-language={props.language}
        value={props.value ?? ''}
        onChange={(event) => props.onChange?.(event.target.value)}
      />
    );
  }
  return { __esModule: true, default: MockMonaco, __harness: harness };
});

import React from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom';
import { axe } from 'jest-axe';
import 'jest-axe/extend-expect';
import { SchemaTestBench } from '../src/app/components/ade/dashboard/test-bench/SchemaTestBench';
import { BENCH_MARKER_OWNER } from '../src/app/utils/schema-test-bench';
import { loadSavedBenchPayloads } from '../src/app/utils/schema-test-bench-saved-payloads';
import { TEST_BENCH_PAYLOAD_MAX_BYTES } from '../src/app/utils/preview-budgets';

const { __harness: monacoHarness } = jest.requireMock('@monaco-editor/react') as {
  __harness: {
    editor: { revealLineInCenter: jest.Mock; setPosition: jest.Mock; focus: jest.Mock };
    monaco: { editor: { setModelMarkers: jest.Mock } };
    reset: () => void;
  };
};

const AXE_OPTIONS = {
  rules: {
    'color-contrast': { enabled: false },
    region: { enabled: false },
  },
} as const;

const TENANT = 'tenant-1';

/** The targets payload the bench's picker renders. */
const TARGETS_PAYLOAD = {
  success: true,
  tenant_slug: 'acme',
  schema_ref: 'catalog/legacy-soap/latest',
  types: [
    { key: 'acme.Order', name: 'Order', kind: 'record' },
    { key: 'acme.Status', name: 'Status', kind: 'enum' },
  ],
  operation_bodies: [
    {
      operation_key: 'POST /orders',
      operation_name: 'createOrder',
      http_method: 'POST',
      http_path: '/orders',
      role: 'request',
      status_code: null,
      type_key: 'acme.Order',
      type_name: 'Order',
      list_wrapped: false,
    },
  ],
  xml_document: false,
  diagnostics: [],
};

const PRIMITIVES_PAYLOAD = {
  success: true,
  primitives: [
    {
      id: 'prim-1',
      name: 'email',
      namespace: 'std/v0/primitives',
      schema_id: 'https://api.apiome.dev/types/std/v0/primitives/email',
    },
  ],
};

const INVALID_VALIDATION = {
  success: true,
  ok: true,
  valid: false,
  validated: true,
  validator: 'jsonschema/2020-12',
  schema_ref: 'catalog/legacy-soap/latest/acme.Order',
  findings: [
    {
      pointer: '/age',
      keyword: 'type',
      schema_pointer: '/properties/age/type',
      message: "'old' is not of type 'integer'",
    },
  ],
  total_findings: 1,
  truncated: false,
  diagnostics: [],
};

const VALID_VALIDATION = {
  success: true,
  ok: true,
  valid: true,
  validated: true,
  validator: 'jsonschema/2020-12',
  findings: [],
  total_findings: 0,
  truncated: false,
  diagnostics: [],
};

const SYNTHESIS_PAYLOAD = {
  success: true,
  ok: true,
  synthetic: true,
  notice: 'All payloads are synthetic.',
  seed: 0,
  instances: [
    {
      id: 'valid-minimal',
      kind: 'minimal',
      title: 'Minimal valid',
      description: 'Required properties only.',
      instance: { age: 1 },
      synthetic: true,
      expected_valid: true,
      valid: true,
    },
    {
      id: 'mutant-1',
      kind: 'mutant',
      title: 'type-wrong: age',
      description: 'Violates the type of age.',
      instance: { age: 'old' },
      synthetic: true,
      expected_valid: false,
      valid: false,
    },
  ],
  rejected_mutants: 2,
  diagnostics: [],
};

/** Route the bench's fetches; per-test overrides swap the validate/synthesize responses. */
function mockFetch(overrides: { validate?: unknown; synthesize?: unknown; targets?: unknown } = {}) {
  const fetchMock = jest.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    const respond = (body: unknown) =>
      ({ ok: true, status: 200, json: async () => body }) as Response;
    if (url.startsWith('/api/schemas/targets')) return respond(overrides.targets ?? TARGETS_PAYLOAD);
    if (url === '/api/primitives') return respond(PRIMITIVES_PAYLOAD);
    if (url === '/api/schemas/validate') return respond(overrides.validate ?? INVALID_VALIDATION);
    if (url === '/api/schemas/synthesize') return respond(overrides.synthesize ?? SYNTHESIS_PAYLOAD);
    throw new Error(`Unexpected fetch: ${url}`);
  });
  global.fetch = fetchMock as unknown as typeof fetch;
  return fetchMock;
}

function renderBench() {
  return render(
    <SchemaTestBench
      surface="catalog"
      artifact="legacy-soap"
      artifactName="Legacy SOAP"
      tenantId={TENANT}
      active
    />,
  );
}

/** Select the Order component schema in the picker. */
async function pickOrderSchema() {
  const select = await screen.findByTestId('test-bench-schema-select');
  await waitFor(() =>
    expect(screen.getByRole('option', { name: 'Order (record)' })).toBeInTheDocument(),
  );
  const option = screen.getByRole('option', { name: 'Order (record)' }) as HTMLOptionElement;
  fireEvent.change(select, { target: { value: option.value } });
}

beforeEach(() => {
  window.localStorage.clear();
  monacoHarness.reset();
  Object.assign(navigator, { clipboard: { writeText: jest.fn().mockResolvedValue(undefined) } });
});

describe('SchemaTestBench', () => {
  it('offers schemas from operation bodies, component schemas, and registry types', async () => {
    mockFetch();
    renderBench();

    await waitFor(() =>
      expect(screen.getByRole('option', { name: 'POST /orders — request body (Order)' })).toBeInTheDocument(),
    );
    expect(screen.getByRole('group', { name: 'Operation bodies' })).toBeInTheDocument();
    expect(screen.getByRole('group', { name: 'Component schemas' })).toBeInTheDocument();
    expect(screen.getByRole('group', { name: 'Registry types' })).toBeInTheDocument();
    expect(screen.getByRole('option', { name: 'std/v0/primitives/email' })).toBeInTheDocument();

    // An operation-body selection resolves to the very type reference it names.
    const select = screen.getByTestId('test-bench-schema-select');
    const opOption = screen.getByRole('option', {
      name: 'POST /orders — request body (Order)',
    }) as HTMLOptionElement;
    fireEvent.change(select, { target: { value: opOption.value } });
    expect(screen.getByTestId('test-bench-selected-ref')).toHaveTextContent(
      'catalog/legacy-soap/latest/acme.Order',
    );
  });

  it('offers a whole-document entry for XML-grammar-backed revisions', async () => {
    mockFetch({ targets: { ...TARGETS_PAYLOAD, xml_document: true } });
    renderBench();

    await waitFor(() =>
      expect(screen.getByRole('option', { name: 'Whole XML document' })).toBeInTheDocument(),
    );
  });

  it('validates a payload and anchors findings as inline markers and clickable rows', async () => {
    const fetchMock = mockFetch();
    renderBench();
    await pickOrderSchema();

    fireEvent.change(screen.getByTestId('mock-monaco'), {
      target: { value: '{\n  "age": "old"\n}' },
    });
    fireEvent.click(screen.getByTestId('test-bench-validate'));

    // Status line + findings list.
    await waitFor(() =>
      expect(screen.getByTestId('test-bench-status')).toHaveTextContent('Payload is invalid — 1 finding'),
    );
    expect(screen.getByTestId('test-bench-finding-0')).toHaveTextContent('/age');

    // The validate request carried the reference and the raw text.
    const validateCall = fetchMock.mock.calls.find(([url]) => url === '/api/schemas/validate');
    expect(JSON.parse((validateCall![1] as RequestInit).body as string)).toMatchObject({
      ref: 'catalog/legacy-soap/latest/acme.Order',
      instance_text: '{\n  "age": "old"\n}',
      media_type: 'application/json',
    });

    // Inline marker anchored to the /age value ("old" on line 2), under the bench's owner.
    const markerCall = monacoHarness.monaco.editor.setModelMarkers.mock.calls.findLast(
      (call) => Array.isArray(call[2]) && call[2].length > 0,
    );
    expect(markerCall![1]).toBe(BENCH_MARKER_OWNER);
    expect(markerCall![2][0]).toMatchObject({ startLineNumber: 2, startColumn: 10 });

    // Clicking the finding reveals its range in the editor.
    fireEvent.click(screen.getByTestId('test-bench-finding-0'));
    expect(monacoHarness.editor.revealLineInCenter).toHaveBeenCalledWith(2);
    expect(monacoHarness.editor.focus).toHaveBeenCalled();
  });

  it('loads generated payloads in one click, labelled synthetic end to end', async () => {
    mockFetch();
    renderBench();
    await pickOrderSchema();

    fireEvent.click(screen.getByTestId('test-bench-generate'));
    await waitFor(() => expect(screen.getByTestId('test-bench-load-valid-minimal')).toBeInTheDocument());

    // Chips are grouped and labelled; honesty counters surface.
    expect(screen.getByTestId('test-bench-generated-valid')).toHaveTextContent('Minimal valid');
    expect(screen.getByTestId('test-bench-generated-mutants')).toHaveTextContent('type-wrong: age');
    expect(screen.getByTestId('test-bench-rejected-mutants')).toHaveTextContent('2 mutant candidates');

    // One click loads the payload; the editor content carries the Synthetic badge.
    fireEvent.click(screen.getByTestId('test-bench-load-valid-minimal'));
    expect(screen.getByTestId('mock-monaco')).toHaveValue('{\n  "age": 1\n}');
    expect(screen.getByTestId('test-bench-synthetic-badge')).toBeInTheDocument();

    // A manual edit makes the content user-authored again: the badge must not overclaim.
    fireEvent.change(screen.getByTestId('mock-monaco'), { target: { value: '{"age": 2}' } });
    expect(screen.queryByTestId('test-bench-synthetic-badge')).not.toBeInTheDocument();
  });

  it('saves and reloads payloads per schema, tenant-scoped, keeping the synthetic label', async () => {
    mockFetch();
    renderBench();
    await pickOrderSchema();

    fireEvent.click(screen.getByTestId('test-bench-generate'));
    await waitFor(() => expect(screen.getByTestId('test-bench-load-valid-minimal')).toBeInTheDocument());
    fireEvent.click(screen.getByTestId('test-bench-load-valid-minimal'));

    fireEvent.change(screen.getByTestId('test-bench-save-name'), { target: { value: 'minimal' } });
    fireEvent.click(screen.getByTestId('test-bench-save'));

    // Stored under the tenant + schema scope, synthetic label intact.
    const stored = loadSavedBenchPayloads(TENANT, 'catalog/legacy-soap/latest/acme.Order');
    expect(stored).toHaveLength(1);
    expect(stored[0]).toMatchObject({ name: 'minimal', synthetic: true });

    // Clear the editor, then reload the saved payload.
    fireEvent.change(screen.getByTestId('mock-monaco'), { target: { value: '' } });
    fireEvent.click(screen.getByTestId(`test-bench-saved-load-${stored[0].id}`));
    expect(screen.getByTestId('mock-monaco')).toHaveValue('{\n  "age": 1\n}');
    expect(screen.getByTestId('test-bench-synthetic-badge')).toBeInTheDocument();
  });

  it('copies a curl command with the tenant slug and no embedded credential', async () => {
    mockFetch();
    renderBench();
    await pickOrderSchema();

    fireEvent.change(screen.getByTestId('mock-monaco'), { target: { value: '{"age": 1}' } });
    fireEvent.click(screen.getByTestId('test-bench-copy-curl'));

    await waitFor(() => expect(navigator.clipboard.writeText).toHaveBeenCalled());
    const copied = (navigator.clipboard.writeText as jest.Mock).mock.calls[0][0] as string;
    expect(copied).toContain('/tenants/acme/schemas/catalog/legacy-soap/latest/acme.Order/validate');
    expect(copied).toContain('$APIOME_API_KEY');
  });

  it('exports a corpus fixture only for the exact text that just validated', async () => {
    mockFetch({ validate: VALID_VALIDATION });
    renderBench();
    await pickOrderSchema();

    fireEvent.change(screen.getByTestId('mock-monaco'), { target: { value: '{"age": 1}' } });
    // Before validation, the fixture action is off with an explanatory title.
    expect(screen.getByTestId('test-bench-copy-fixture')).toBeDisabled();

    fireEvent.click(screen.getByTestId('test-bench-validate'));
    await waitFor(() => expect(screen.getByTestId('test-bench-copy-fixture')).toBeEnabled());

    fireEvent.click(screen.getByTestId('test-bench-copy-fixture'));
    await waitFor(() => expect(navigator.clipboard.writeText).toHaveBeenCalled());
    const copied = JSON.parse(
      (navigator.clipboard.writeText as jest.Mock).mock.calls[0][0] as string,
    );
    expect(copied.manifest_entry).toMatchObject({
      validity_class: 'valid',
      expected_outcome: 'imports',
      format: 'json-schema',
    });
    expect(copied.manifest_entry.provenance).toContain('catalog/legacy-soap/latest/acme.Order');
    expect(copied.file.content).toBe('{"age": 1}');

    // Editing after validation revokes the export until the payload passes again.
    fireEvent.change(screen.getByTestId('mock-monaco'), { target: { value: '{"age": 2}' } });
    expect(screen.getByTestId('test-bench-copy-fixture')).toBeDisabled();
  });

  it('refuses to validate a payload above the IXH-3.6 byte budget, with a stated bound', async () => {
    const fetchMock = mockFetch();
    renderBench();
    await pickOrderSchema();

    const huge = `{"pad": "${'x'.repeat(TEST_BENCH_PAYLOAD_MAX_BYTES)}"}`;
    fireEvent.change(screen.getByTestId('mock-monaco'), { target: { value: huge } });
    fireEvent.click(screen.getByTestId('test-bench-validate'));

    await waitFor(() =>
      expect(screen.getByTestId('test-bench-status')).toHaveTextContent('above the Test Bench bound'),
    );
    expect(fetchMock.mock.calls.some(([url]) => url === '/api/schemas/validate')).toBe(false);
  });

  it('windows the findings list above the IXH-3.6 budget, with the behavior stated', async () => {
    const manyFindings = Array.from({ length: 80 }, (_, i) => ({
      pointer: `/items/${i}`,
      keyword: 'type',
      message: `item ${i} is wrong`,
    }));
    mockFetch({
      validate: {
        ...INVALID_VALIDATION,
        findings: manyFindings,
        total_findings: 80,
      },
    });
    renderBench();
    await pickOrderSchema();

    fireEvent.change(screen.getByTestId('mock-monaco'), { target: { value: '{"items": []}' } });
    fireEvent.click(screen.getByTestId('test-bench-validate'));

    await waitFor(() =>
      expect(screen.getByRole('region', { name: 'Findings (80, windowed)' })).toBeInTheDocument(),
    );
    // The list states its behavior ("windowed" note) and only the rows near the viewport
    // mount — the row far outside the fixed viewport is not in the DOM.
    expect(screen.getByText(/windowed — every finding stays reachable/)).toBeInTheDocument();
    expect(screen.getByTestId('test-bench-finding-0')).toBeInTheDocument();
    expect(screen.queryByTestId('test-bench-finding-79')).not.toBeInTheDocument();
  });

  it('surfaces a targets addressing fault instead of an empty picker', async () => {
    mockFetch();
    (global.fetch as jest.Mock).mockImplementationOnce(async () => ({
      ok: false,
      status: 404,
      json: async () => ({ success: false, detail: { message: 'No catalog named x is visible.' } }),
    }));
    renderBench();

    await waitFor(() =>
      expect(screen.getByTestId('test-bench-targets-error')).toHaveTextContent(
        'No catalog named x is visible.',
      ),
    );
  });

  it('passes the a11y suite in its richest state (findings + chips + saved payloads)', async () => {
    mockFetch();
    const { container } = renderBench();
    await pickOrderSchema();

    fireEvent.click(screen.getByTestId('test-bench-generate'));
    await waitFor(() => expect(screen.getByTestId('test-bench-load-valid-minimal')).toBeInTheDocument());
    fireEvent.click(screen.getByTestId('test-bench-load-valid-minimal'));
    fireEvent.change(screen.getByTestId('test-bench-save-name'), { target: { value: 'minimal' } });
    fireEvent.click(screen.getByTestId('test-bench-save'));
    fireEvent.click(screen.getByTestId('test-bench-validate'));
    await waitFor(() => expect(screen.getByTestId('test-bench-status')).toBeInTheDocument());

    expect(await axe(container, AXE_OPTIONS)).toHaveNoViolations();
  });
});
