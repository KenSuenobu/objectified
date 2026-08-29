/**
 * Render/interaction tests for the mock scenario override editor (#4454, SIM-4.2)
 * and the latency/chaos knobs (#4455, SIM-4.3).
 *
 * Acceptance criteria under test:
 * - Opening the editor loads persisted definitions from the scenarios proxy route.
 * - Saving round-trips the canonical payload through `PUT /api/versions/{id}/mock/scenarios`.
 * - Client-side JSON/field errors block the save and are listed inline.
 * - Server-side validation failures (REST 422) are listed inline.
 * - Chaos knobs (delay/jitter/error rate, per version default, per route, and
 *   per scenario) load, validate, and serialize into the same PUT payload.
 * - The MSC-1.3 (#5529) additions — the `{{ ... }}` token picker beside the templated fields and
 *   the live preview of the unsaved draft — offer this version's own parameters and fixtures, and
 *   leave the editor's existing behaviour untouched when the catalogue cannot be loaded.
 */

import React from 'react';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import '@testing-library/jest-dom';
import { MockScenarioEditor } from '../src/app/components/ade/dashboard/MockScenarioEditor';
import { toast } from 'sonner';

jest.mock('sonner', () => ({
  toast: { success: jest.fn(), error: jest.fn() },
}));

const STORED_SCENARIOS = {
  'quota-exceeded': {
    description: 'Throttled.',
    operations: {
      'GET /pets': {
        responses: [
          { status: 429, headers: { 'Retry-After': '60' }, body: { error: 'quota' } },
        ],
      },
    },
  },
};

const baseProps = {
  versionRecordId: 'rev-1',
  projectId: 'proj-1',
  versionLabel: '1.0.0',
  open: true,
  onOpenChange: jest.fn(),
};

const renderEditor = (overrides: Partial<React.ComponentProps<typeof MockScenarioEditor>> = {}) =>
  render(<MockScenarioEditor {...baseProps} {...overrides} />);

/** Mock the GET load; subsequent calls fall through to `putResponse` when given. */
const mockFetch = (
  scenarios: unknown,
  putResponse?: { ok: boolean; json: unknown },
  chaos: unknown = null
) => {
  (global.fetch as jest.Mock).mockImplementation(async (_url: string, init?: RequestInit) => {
    if (init?.method === 'PUT') {
      return {
        ok: putResponse?.ok ?? true,
        json: async () => putResponse?.json ?? { success: true, scenarios: {} },
      };
    }
    return { ok: true, json: async () => ({ success: true, scenarios, chaos }) };
  });
};

/** Find the PUT proxy call and return its parsed JSON body. */
const putBody = (): Record<string, unknown> | undefined => {
  const putCall = (global.fetch as jest.Mock).mock.calls.find(
    ([, init]) => init?.method === 'PUT'
  );
  return putCall ? JSON.parse(putCall[1].body as string) : undefined;
};

let consoleErrorSpy: jest.SpyInstance;

beforeEach(() => {
  jest.clearAllMocks();
  (global as { fetch: unknown }).fetch = jest.fn();
  consoleErrorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  consoleErrorSpy.mockRestore();
});

describe('MockScenarioEditor — loading', () => {
  it('loads persisted scenarios through the proxy route when opened', async () => {
    mockFetch(STORED_SCENARIOS);
    renderEditor();

    await waitFor(() =>
      expect(screen.getByLabelText('Scenario 1 name')).toHaveValue('quota-exceeded')
    );
    expect(global.fetch).toHaveBeenCalledWith(
      '/api/versions/rev-1/mock/scenarios?projectId=proj-1'
    );
    expect(screen.getByLabelText('Scenario 1 description')).toHaveValue('Throttled.');
    expect(screen.getByLabelText('Scenario 1 operation 1 key')).toHaveValue('GET /pets');
    expect(screen.getByLabelText('Scenario 1 operation 1 response 1 status')).toHaveValue('429');
  });

  it('shows an error toast when loading fails', async () => {
    (global.fetch as jest.Mock).mockResolvedValue({
      ok: false,
      json: async () => ({ success: false, error: 'Version not found' }),
    });
    renderEditor();

    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('Version not found'));
  });

  it('does not fetch while closed', () => {
    renderEditor({ open: false });
    expect(global.fetch).not.toHaveBeenCalled();
  });
});

describe('MockScenarioEditor — saving', () => {
  it('round-trips the canonical payload through the PUT proxy route', async () => {
    mockFetch(STORED_SCENARIOS, { ok: true, json: { success: true, scenarios: STORED_SCENARIOS } });
    const onOpenChange = jest.fn();
    renderEditor({ onOpenChange });

    await waitFor(() =>
      expect(screen.getByLabelText('Scenario 1 name')).toHaveValue('quota-exceeded')
    );
    fireEvent.click(screen.getByTestId('mock-scenario-save'));

    await waitFor(() => expect(toast.success).toHaveBeenCalledWith('Scenarios saved for v1.0.0.'));
    const putCall = (global.fetch as jest.Mock).mock.calls.find(
      ([, init]) => init?.method === 'PUT'
    );
    expect(putCall).toBeDefined();
    expect(putCall![0]).toBe('/api/versions/rev-1/mock/scenarios');
    const body = JSON.parse(putCall![1].body as string);
    expect(body.projectId).toBe('proj-1');
    expect(body.scenarios['quota-exceeded'].operations['GET /pets'].responses[0]).toEqual({
      status: 429,
      headers: { 'Retry-After': '60' },
      body: { error: 'quota' },
    });
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it('supports authoring a new scenario with a sequence', async () => {
    mockFetch({}, { ok: true, json: { success: true, scenarios: {} } });
    renderEditor();

    await waitFor(() => expect(screen.getByTestId('mock-scenario-add')).toBeInTheDocument());
    fireEvent.click(screen.getByTestId('mock-scenario-add'));
    fireEvent.change(screen.getByLabelText('Scenario 1 name'), {
      target: { value: 'flaky-then-ok' },
    });
    fireEvent.click(screen.getByRole('button', { name: /Add operation override/ }));
    fireEvent.change(screen.getByLabelText('Scenario 1 operation 1 key'), {
      target: { value: 'GET /pets' },
    });
    fireEvent.change(screen.getByLabelText('Scenario 1 operation 1 response 1 status'), {
      target: { value: '503' },
    });
    fireEvent.click(screen.getByRole('button', { name: /Add sequence step/ }));
    fireEvent.change(screen.getByLabelText('Scenario 1 operation 1 response 2 status'), {
      target: { value: '200' },
    });
    fireEvent.click(screen.getByTestId('mock-scenario-save'));

    await waitFor(() => expect(toast.success).toHaveBeenCalled());
    const putCall = (global.fetch as jest.Mock).mock.calls.find(
      ([, init]) => init?.method === 'PUT'
    );
    const body = JSON.parse(putCall![1].body as string);
    expect(body.scenarios['flaky-then-ok'].operations['GET /pets'].responses).toEqual([
      { status: 503 },
      { status: 200 },
    ]);
  });

  it('blocks the save and lists client-side errors for invalid JSON bodies', async () => {
    mockFetch(STORED_SCENARIOS);
    renderEditor();

    await waitFor(() =>
      expect(screen.getByLabelText('Scenario 1 name')).toHaveValue('quota-exceeded')
    );
    fireEvent.change(screen.getByLabelText('Scenario 1 operation 1 response 1 body'), {
      target: { value: '{not json' },
    });
    fireEvent.click(screen.getByTestId('mock-scenario-save'));

    await waitFor(() => expect(screen.getByTestId('mock-scenario-errors')).toBeInTheDocument());
    expect(screen.getByText(/body must be valid JSON/)).toBeInTheDocument();
    const putCall = (global.fetch as jest.Mock).mock.calls.find(
      ([, init]) => init?.method === 'PUT'
    );
    expect(putCall).toBeUndefined();
  });

  it('lists REST validation errors returned by the PUT route', async () => {
    mockFetch(STORED_SCENARIOS, {
      ok: false,
      json: {
        success: false,
        error: 'Scenario definitions failed validation.',
        errors: ["Scenario 'quota-exceeded', operation 'GET /pets': no operation GET /pets exists in this version's spec."],
      },
    });
    renderEditor();

    await waitFor(() =>
      expect(screen.getByLabelText('Scenario 1 name')).toHaveValue('quota-exceeded')
    );
    fireEvent.click(screen.getByTestId('mock-scenario-save'));

    await waitFor(() => expect(screen.getByTestId('mock-scenario-errors')).toBeInTheDocument());
    expect(screen.getByText(/no operation GET \/pets exists/)).toBeInTheDocument();
    expect(toast.success).not.toHaveBeenCalled();
  });
});

describe('MockScenarioEditor — latency & chaos (#4455, SIM-4.3)', () => {
  it('loads stored chaos knobs into the editor', async () => {
    mockFetch({}, undefined, {
      default: { delayMs: 800, jitterMs: 200, errorRate: 10 },
      operations: { 'GET /pets': { errorRate: 50 } },
    });
    renderEditor();

    await waitFor(() => expect(screen.getByLabelText('Chaos default delay ms')).toHaveValue('800'));
    expect(screen.getByLabelText('Chaos default jitter ms')).toHaveValue('200');
    expect(screen.getByLabelText('Chaos default error rate percent')).toHaveValue('10');
    expect(screen.getByLabelText('Chaos route 1 key')).toHaveValue('GET /pets');
    expect(screen.getByLabelText('Chaos route 1 error rate percent')).toHaveValue('50');
  });

  it('serializes version-default and per-route knobs into the PUT payload', async () => {
    mockFetch({}, { ok: true, json: { success: true, scenarios: {}, chaos: {} } });
    renderEditor();

    await waitFor(() => expect(screen.getByTestId('mock-chaos-editor')).toBeInTheDocument());
    fireEvent.change(screen.getByLabelText('Chaos default delay ms'), { target: { value: '800' } });
    fireEvent.change(screen.getByLabelText('Chaos default jitter ms'), { target: { value: '200' } });
    fireEvent.change(screen.getByLabelText('Chaos default error rate percent'), {
      target: { value: '10' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Add chaos route override' }));
    fireEvent.change(screen.getByLabelText('Chaos route 1 key'), {
      target: { value: 'GET /pets' },
    });
    fireEvent.change(screen.getByLabelText('Chaos route 1 error rate percent'), {
      target: { value: '50' },
    });
    fireEvent.click(screen.getByTestId('mock-scenario-save'));

    await waitFor(() => expect(toast.success).toHaveBeenCalled());
    const body = putBody();
    expect(body!.chaos).toEqual({
      default: { delayMs: 800, jitterMs: 200, errorRate: 10 },
      operations: { 'GET /pets': { errorRate: 50 } },
    });
  });

  it('omits the chaos key entirely when every knob is blank', async () => {
    mockFetch(STORED_SCENARIOS, { ok: true, json: { success: true, scenarios: {} } });
    renderEditor();

    await waitFor(() =>
      expect(screen.getByLabelText('Scenario 1 name')).toHaveValue('quota-exceeded')
    );
    fireEvent.click(screen.getByTestId('mock-scenario-save'));

    await waitFor(() => expect(toast.success).toHaveBeenCalled());
    expect(putBody()).not.toHaveProperty('chaos');
  });

  it('blocks the save when a knob is out of range', async () => {
    mockFetch({});
    renderEditor();

    await waitFor(() => expect(screen.getByTestId('mock-chaos-editor')).toBeInTheDocument());
    fireEvent.change(screen.getByLabelText('Chaos default delay ms'), {
      target: { value: '50000' },
    });
    fireEvent.click(screen.getByTestId('mock-scenario-save'));

    await waitFor(() => expect(screen.getByTestId('mock-scenario-errors')).toBeInTheDocument());
    expect(screen.getByText(/delay must be a whole number between 0 and 30000/)).toBeInTheDocument();
    expect(putBody()).toBeUndefined();
  });

  it('blocks the save when delay plus jitter exceed the 30s cap', async () => {
    mockFetch({});
    renderEditor();

    await waitFor(() => expect(screen.getByTestId('mock-chaos-editor')).toBeInTheDocument());
    fireEvent.change(screen.getByLabelText('Chaos default delay ms'), {
      target: { value: '20000' },
    });
    fireEvent.change(screen.getByLabelText('Chaos default jitter ms'), {
      target: { value: '15000' },
    });
    fireEvent.click(screen.getByTestId('mock-scenario-save'));

    await waitFor(() => expect(screen.getByTestId('mock-scenario-errors')).toBeInTheDocument());
    expect(screen.getByText(/delay \+ jitter must not exceed 30000 ms/)).toBeInTheDocument();
    expect(putBody()).toBeUndefined();
  });

  it('serializes scenario-scoped chaos inside the scenario entry', async () => {
    mockFetch(STORED_SCENARIOS, { ok: true, json: { success: true, scenarios: {} } });
    renderEditor();

    await waitFor(() =>
      expect(screen.getByLabelText('Scenario 1 name')).toHaveValue('quota-exceeded')
    );
    fireEvent.click(screen.getByRole('button', { name: 'Add scenario 1 chaos' }));
    fireEvent.change(screen.getByLabelText('Scenario 1 chaos default error rate percent'), {
      target: { value: '100' },
    });
    fireEvent.click(screen.getByTestId('mock-scenario-save'));

    await waitFor(() => expect(toast.success).toHaveBeenCalled());
    const body = putBody();
    const scenarios = body!.scenarios as Record<string, { chaos?: unknown }>;
    expect(scenarios['quota-exceeded'].chaos).toEqual({ default: { errorRate: 100 } });
    expect(body).not.toHaveProperty('chaos');
  });

  it('loads stored scenario-scoped chaos and allows removing it', async () => {
    mockFetch(
      {
        degraded: {
          operations: {},
          chaos: { default: { delayMs: 500 } },
        },
      },
      { ok: true, json: { success: true, scenarios: {} } }
    );
    renderEditor();

    await waitFor(() =>
      expect(screen.getByLabelText('Scenario 1 chaos default delay ms')).toHaveValue('500')
    );
    fireEvent.click(screen.getByRole('button', { name: 'Remove scenario 1 chaos' }));
    fireEvent.click(screen.getByTestId('mock-scenario-save'));

    await waitFor(() => expect(toast.success).toHaveBeenCalled());
    const body = putBody();
    const scenarios = body!.scenarios as Record<string, { chaos?: unknown }>;
    expect(scenarios.degraded).not.toHaveProperty('chaos');
  });
});

describe('MockScenarioEditor — match rules and templates (#4744, PMR-2.1)', () => {
  const RULES = [
    { when: { query: { limit: { gt: 10 } } }, responses: [{ status: 429 }] },
  ];

  it('round-trips stored match rules through the rules textarea', async () => {
    mockFetch({
      personalized: {
        operations: {
          'GET /pets': {
            rules: RULES,
            responses: [{ status: 200, body: [] }],
          },
        },
      },
    });
    renderEditor();

    const rulesField = await screen.findByLabelText('Scenario 1 operation 1 match rules');
    expect(rulesField).toHaveValue(JSON.stringify(RULES, null, 2));

    fireEvent.click(screen.getByTestId('mock-scenario-save'));
    await waitFor(() => expect(putBody()).toBeDefined());
    const scenarios = putBody()?.scenarios as Record<string, {
      operations: Record<string, { rules?: unknown; responses?: unknown }>;
    }>;
    expect(scenarios.personalized.operations['GET /pets'].rules).toEqual(RULES);
    expect(scenarios.personalized.operations['GET /pets'].responses).toEqual([
      { status: 200, body: [] },
    ]);
  });

  it('saves a rules-only operation without fallback responses', async () => {
    mockFetch({
      personalized: {
        operations: { 'GET /pets': { rules: RULES } },
      },
    });
    renderEditor();

    await screen.findByLabelText('Scenario 1 operation 1 match rules');
    fireEvent.click(screen.getByTestId('mock-scenario-save'));
    await waitFor(() => expect(putBody()).toBeDefined());
    const scenarios = putBody()?.scenarios as Record<string, {
      operations: Record<string, { rules?: unknown; responses?: unknown }>;
    }>;
    expect(scenarios.personalized.operations['GET /pets'].rules).toEqual(RULES);
    expect(scenarios.personalized.operations['GET /pets'].responses).toBeUndefined();
  });

  it('blocks the save and lists an error when the rules JSON is invalid', async () => {
    mockFetch(STORED_SCENARIOS);
    renderEditor();

    const rulesField = await screen.findByLabelText('Scenario 1 operation 1 match rules');
    fireEvent.change(rulesField, { target: { value: '{not json' } });
    fireEvent.click(screen.getByTestId('mock-scenario-save'));

    await waitFor(() => expect(screen.getByTestId('mock-scenario-errors')).toBeInTheDocument());
    expect(screen.getByTestId('mock-scenario-errors').textContent).toContain(
      'match rules must be valid JSON'
    );
    expect(putBody()).toBeUndefined();
  });

  it('blocks the save when a rule is missing predicates or responses', async () => {
    mockFetch(STORED_SCENARIOS);
    renderEditor();

    const rulesField = await screen.findByLabelText('Scenario 1 operation 1 match rules');
    fireEvent.change(rulesField, {
      target: { value: JSON.stringify([{ when: {}, responses: [] }]) },
    });
    fireEvent.click(screen.getByTestId('mock-scenario-save'));

    await waitFor(() => expect(screen.getByTestId('mock-scenario-errors')).toBeInTheDocument());
    expect(screen.getByTestId('mock-scenario-errors').textContent).toContain(
      "'responses' must be a non-empty array"
    );
    expect(putBody()).toBeUndefined();
  });

  it('surfaces server-side template validation errors from the 422 response', async () => {
    mockFetch(STORED_SCENARIOS, {
      ok: false,
      json: {
        success: false,
        errors: ["Scenario 'quota-exceeded', operation 'GET /pets', response 1, body: unknown expression root"],
      },
    });
    renderEditor();

    await screen.findByLabelText('Scenario 1 operation 1 key');
    fireEvent.click(screen.getByTestId('mock-scenario-save'));

    await waitFor(() => expect(screen.getByTestId('mock-scenario-errors')).toBeInTheDocument());
    expect(screen.getByTestId('mock-scenario-errors').textContent).toContain(
      'unknown expression root'
    );
  });
});

// ==================================================================================================
// MSC-1.3 (#5529): the token picker and the live preview
// ==================================================================================================

const CATALOGUE = {
  success: true,
  operations: [
    {
      key: 'GET /pets',
      method: 'GET',
      path: '/pets',
      summary: 'List pets',
      parameters: [
        {
          name: 'limit',
          location: 'query',
          required: false,
          type: 'integer',
          token: '{{request.query.limit}}',
        },
      ],
      requestFields: [],
      responsePointers: [],
      successStatus: 200,
      bindings: [],
    },
  ],
  fixtures: ['pets'],
};

const SCENARIO_PREVIEW = {
  operation: 'GET /pets',
  status: 429,
  headers: {},
  mediaType: 'application/json',
  body: { error: 'quota' },
  bodyEncoding: 'json',
  trace: { layer: 'scenario', detail: 'Scenario quota-exceeded answered.', scenario: 'quota-exceeded', ruleIndex: 0 },
  chaos: { suppressed: false, delayMs: 0, jitterMs: 0, errorRate: 0 },
  draft: true,
};

/** Route the scenario load, the authoring catalogue and the preview render. */
const mockAuthoringFetch = (
  overrides: { catalogue?: { ok: boolean; json: unknown }; preview?: { ok: boolean; json: unknown } } = {}
) => {
  (global.fetch as jest.Mock).mockImplementation(async (url: string, init?: RequestInit) => {
    if (init?.method === 'POST') {
      return {
        ok: overrides.preview?.ok ?? true,
        json: async () => overrides.preview?.json ?? { success: true, preview: SCENARIO_PREVIEW },
      };
    }
    if (String(url).includes('/mock/operations')) {
      return {
        ok: overrides.catalogue?.ok ?? true,
        json: async () => overrides.catalogue?.json ?? CATALOGUE,
      };
    }
    return { ok: true, json: async () => ({ success: true, scenarios: STORED_SCENARIOS, chaos: null }) };
  });
};

describe('MockScenarioEditor — token picker (MSC-1.3)', () => {
  it('inserts a token this version actually has into the response body', async () => {
    mockAuthoringFetch();
    renderEditor();

    await screen.findByLabelText('Scenario 1 operation 1 key');
    const picker = screen.getByTestId('mock-scenario-0-0-0-body-tokens');
    fireEvent.click(within(picker).getByRole('button', { name: /Insert a token/ }));
    fireEvent.click(within(picker).getByTitle(/^\{\{request\.query\.limit\}\}/));

    // Inserted at the caret — position 0 for a field the test never focused.
    expect(screen.getByLabelText('Scenario 1 operation 1 response 1 body')).toHaveValue(
      '{{request.query.limit}}{\n  "error": "quota"\n}'
    );
  });

  it('offers the version’s fixture names', async () => {
    mockAuthoringFetch();
    renderEditor();

    await screen.findByLabelText('Scenario 1 operation 1 key');
    const picker = screen.getByTestId('mock-scenario-0-0-0-body-tokens');
    fireEvent.click(within(picker).getByRole('button', { name: /Insert a token/ }));

    expect(within(picker).getByTitle(/^\{\{fixture\.pets\}\}/)).toBeInTheDocument();
  });

  it('opens even when the catalogue request never lands', async () => {
    // The catalogue is an enhancement; a network failure fetching it must not take the scenario
    // editor down with it, which a bare `Promise.all` would.
    (global.fetch as jest.Mock).mockImplementation(async (url: string) => {
      if (String(url).includes('/mock/operations')) throw new Error('offline');
      return { ok: true, json: async () => ({ success: true, scenarios: STORED_SCENARIOS, chaos: null }) };
    });
    renderEditor();

    expect(await screen.findByLabelText('Scenario 1 operation 1 key')).toHaveValue('GET /pets');
    expect(toast.error).not.toHaveBeenCalled();
  });

  it('leaves the editor usable when the catalogue cannot be loaded', async () => {
    mockAuthoringFetch({ catalogue: { ok: false, json: { success: false, error: 'nope' } } });
    renderEditor();

    await screen.findByLabelText('Scenario 1 operation 1 key');
    // The seeded-value group is always offerable, so the picker never vanishes entirely.
    const picker = screen.getByTestId('mock-scenario-0-0-0-body-tokens');
    fireEvent.click(within(picker).getByRole('button', { name: /Insert a token/ }));
    expect(within(picker).getByTitle(/^\{\{random\.uuid\(\)\}\}/)).toBeInTheDocument();
    expect(screen.queryByLabelText('Preview operation')).not.toBeInTheDocument();
  });
});

describe('MockScenarioEditor — live preview (MSC-1.3)', () => {
  it('renders the unsaved scenarios and names the rule that fired', async () => {
    mockAuthoringFetch();
    renderEditor();

    await screen.findByLabelText('Scenario 1 operation 1 key');
    fireEvent.click(screen.getByTestId('mock-scenario-preview-panel-render'));

    await waitFor(() =>
      expect(screen.getByTestId('mock-scenario-preview-panel-result')).toBeInTheDocument()
    );

    const sent = (global.fetch as jest.Mock).mock.calls.find(([, init]) => init?.method === 'POST');
    expect(JSON.parse(sent![1].body as string).settings.scenarios).toEqual(STORED_SCENARIOS);
    // Nothing was saved to get an answer.
    expect(
      (global.fetch as jest.Mock).mock.calls.some(([, init]) => init?.method === 'PUT')
    ).toBe(false);

    const trace = screen.getByTestId('mock-scenario-preview-panel-trace');
    expect(within(trace).getByText('Scenario')).toBeInTheDocument();
    expect(within(trace).getByText('rule 1')).toBeInTheDocument();
  });

  it('reports an unserializable draft instead of previewing a partial one', async () => {
    mockAuthoringFetch();
    renderEditor();

    await screen.findByLabelText('Scenario 1 operation 1 key');
    fireEvent.change(screen.getByLabelText('Scenario 1 operation 1 response 1 body'), {
      target: { value: '{ not json' },
    });
    fireEvent.click(screen.getByTestId('mock-scenario-preview-panel-render'));

    const errors = await screen.findByTestId('mock-scenario-preview-panel-errors');
    expect(within(errors).getByText(/body must be valid JSON/)).toBeInTheDocument();
    expect(
      (global.fetch as jest.Mock).mock.calls.some(([, init]) => init?.method === 'POST')
    ).toBe(false);
  });
});
