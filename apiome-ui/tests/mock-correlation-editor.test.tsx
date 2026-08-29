/**
 * Render/interaction tests for the response correlation editor (#5529, MSC-1.3).
 *
 * The acceptance criteria this pins, in the ticket's own terms:
 * - switching to `path-params` shows which properties would bind, **without saving**;
 * - an explicit binding can be added by picking an operation and inserting a token, with no raw
 *   JSON typed anywhere;
 * - the live preview renders the unsaved draft and shows the decision trace, and changing the mode
 *   changes what is sent without a save;
 * - a save-time 422 attaches to the row that caused it;
 * - a version with no correlation opens on "Off" with nothing else claimed.
 */

import * as fs from 'fs';
import * as path from 'path';
import React from 'react';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import '@testing-library/jest-dom';
import { axe } from 'jest-axe';
import 'jest-axe/extend-expect';

import { MockCorrelationEditor } from '../src/app/components/ade/dashboard/MockCorrelationEditor';

jest.mock('sonner', () => ({
  toast: { success: jest.fn(), error: jest.fn() },
}));

const OPERATIONS = [
  {
    key: 'GET /pets/{petId}',
    method: 'GET',
    path: '/pets/{petId}',
    summary: 'Fetch one pet',
    parameters: [
      {
        name: 'petId',
        location: 'path',
        required: true,
        type: 'integer',
        token: '{{request.path.petId}}',
      },
    ],
    requestFields: [],
    responsePointers: [{ pointer: '/id', type: 'integer', repeated: false }],
    successStatus: 200,
    bindings: [
      { pointer: '/id', source: '{{request.path.petId}}', pass: 'path-params', repeated: false },
    ],
  },
  {
    key: 'POST /pets',
    method: 'POST',
    path: '/pets',
    summary: 'Create a pet',
    parameters: [],
    requestFields: ['name'],
    responsePointers: [{ pointer: '/name', type: 'string', repeated: false }],
    successStatus: 201,
    bindings: [
      { pointer: '/name', source: '{{request.body#/name}}', pass: 'inferred', repeated: false },
    ],
  },
];

const PREVIEW = {
  operation: 'GET /pets/{petId}',
  status: 200,
  headers: {},
  mediaType: 'application/json',
  body: { id: 42 },
  bodyEncoding: 'json',
  trace: {
    layer: 'correlation',
    detail: 'Correlation (path-params) rewrote the GET /pets/{petId} response.',
    correlationMode: 'path-params',
    correlationApplied: ['path-params'],
    correlationPointers: [],
  },
  chaos: { suppressed: false, delayMs: 0, jitterMs: 0, errorRate: 0 },
  draft: true,
};

/**
 * Contrast is measured against the token layer by `mock-correlation-css.test.ts` (jsdom compiles
 * no stylesheet, so axe would be reading unstyled defaults), and `region` is a page-level rule
 * with no meaning for a dialog rendered on its own.
 */
const AXE_OPTIONS = {
  rules: {
    'color-contrast': { enabled: false },
    region: { enabled: false },
  },
} as const;

const baseProps = {
  versionRecordId: 'rev-1',
  projectId: 'proj-1',
  versionLabel: '1.0.0',
  open: true,
  onOpenChange: jest.fn(),
};

/** Route each proxy call the dialog makes; `overrides` replaces one response. */
const mockFetch = (overrides: {
  correlation?: unknown;
  operations?: { ok: boolean; json: unknown };
  put?: { ok: boolean; json: unknown };
  preview?: { ok: boolean; json: unknown };
} = {}) => {
  (global.fetch as jest.Mock).mockImplementation(async (url: string, init?: RequestInit) => {
    if (init?.method === 'PUT') {
      return {
        ok: overrides.put?.ok ?? true,
        json: async () => overrides.put?.json ?? { success: true, correlation: null },
      };
    }
    if (init?.method === 'POST') {
      return {
        ok: overrides.preview?.ok ?? true,
        json: async () => overrides.preview?.json ?? { success: true, preview: PREVIEW },
      };
    }
    if (String(url).includes('/mock/operations')) {
      return {
        ok: overrides.operations?.ok ?? true,
        json: async () =>
          overrides.operations?.json ?? { success: true, operations: OPERATIONS, fixtures: ['pets'] },
      };
    }
    return { ok: true, json: async () => ({ success: true, correlation: overrides.correlation ?? null }) };
  });
};

/** The parsed body of the one call matching `method`. */
const bodyOf = (method: string): Record<string, unknown> | undefined => {
  const call = (global.fetch as jest.Mock).mock.calls.find(([, init]) => init?.method === method);
  return call ? JSON.parse(call[1].body as string) : undefined;
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

const openEditor = async () => {
  render(<MockCorrelationEditor {...baseProps} />);
  await waitFor(() => expect(screen.getByTestId('mock-correlation-modes')).toBeInTheDocument());
};

describe('loading', () => {
  it('opens on Off for a version with no correlation, claiming nothing else', async () => {
    mockFetch();
    await openEditor();

    expect(screen.getByLabelText('Off')).toBeChecked();
    // No mode card claims a binding, and the explicit rows stay hidden while correlation is off.
    expect(screen.queryByTestId('mock-correlation-bindings')).not.toBeInTheDocument();
    expect(screen.queryByTestId('mock-correlation-inferred-path-params')).not.toBeInTheDocument();
  });

  it('loads the stored block into the rows', async () => {
    mockFetch({
      correlation: {
        mode: 'explicit',
        operations: { 'GET /pets/{petId}': { '/id': '{{request.path.petId}}' } },
      },
    });
    await openEditor();

    expect(screen.getByLabelText('Only my bindings')).toBeChecked();
    expect(screen.getByLabelText('Binding 1 expression')).toHaveValue('{{request.path.petId}}');
    expect(screen.getByLabelText('Binding 1 response pointer')).toHaveValue('/id');
  });
});

describe('the inferred-bindings preview', () => {
  it('shows what path-params would bind, per operation, without saving', async () => {
    mockFetch();
    await openEditor();

    fireEvent.click(screen.getByLabelText('Match path parameters'));

    const preview = screen.getByTestId('mock-correlation-inferred-path-params');
    expect(within(preview).getByText('GET /pets/{petId}')).toBeInTheDocument();
    expect(within(preview).getByText('/id')).toBeInTheDocument();
    expect(within(preview).getByText('{{request.path.petId}}')).toBeInTheDocument();
    // Nothing was written: only the two loads have happened.
    expect((global.fetch as jest.Mock).mock.calls.every(([, init]) => !init?.method)).toBe(true);
  });

  it('adds the request-body echo only in the inferred mode', async () => {
    mockFetch();
    await openEditor();

    fireEvent.click(screen.getByLabelText('Match path parameters'));
    expect(
      within(screen.getByTestId('mock-correlation-inferred-path-params')).queryByText('POST /pets')
    ).not.toBeInTheDocument();

    fireEvent.click(screen.getByLabelText('Match and echo'));
    const inferred = screen.getByTestId('mock-correlation-inferred-inferred');
    expect(within(inferred).getByText('POST /pets')).toBeInTheDocument();
    expect(within(inferred).getByText('{{request.body#/name}}')).toBeInTheDocument();
  });

  it('says so when inference would bind nothing at all', async () => {
    mockFetch({
      operations: {
        ok: true,
        json: {
          success: true,
          operations: [{ ...OPERATIONS[0], bindings: [] }],
          fixtures: [],
        },
      },
    });
    await openEditor();

    fireEvent.click(screen.getByLabelText('Match path parameters'));

    expect(
      within(screen.getByTestId('mock-correlation-inferred-path-params')).getByText(
        /Nothing would be bound automatically/
      )
    ).toBeInTheDocument();
  });
});

describe('the explicit row editor', () => {
  it('adds a binding by picking an operation and inserting a token — no raw JSON', async () => {
    mockFetch();
    await openEditor();

    fireEvent.click(screen.getByLabelText('Only my bindings'));
    fireEvent.click(screen.getByTestId('mock-correlation-add-binding'));

    // The operation comes from a picker over the version's own operations.
    fireEvent.click(screen.getByLabelText('Binding 1 operation'));
    fireEvent.click(await screen.findByRole('option', { name: 'GET /pets/{petId}' }));

    fireEvent.change(screen.getByLabelText('Binding 1 response pointer'), {
      target: { value: '/id' },
    });

    // The expression comes from the token picker, offering this operation's own parameters.
    const picker = screen.getByTestId('mock-correlation-binding-0-tokens');
    fireEvent.click(within(picker).getByRole('button', { name: 'Insert a token into binding 1' }));
    fireEvent.click(within(picker).getByTitle(/^\{\{request\.path\.petId\}\}/));

    expect(screen.getByLabelText('Binding 1 expression')).toHaveValue('{{request.path.petId}}');

    fireEvent.click(screen.getByTestId('mock-correlation-save'));

    await waitFor(() => expect(bodyOf('PUT')).toBeDefined());
    expect(bodyOf('PUT')).toEqual({
      projectId: 'proj-1',
      correlation: {
        mode: 'explicit',
        operations: { 'GET /pets/{petId}': { '/id': '{{request.path.petId}}' } },
      },
    });
  });

  it('blocks the save and marks the row when it is incomplete', async () => {
    mockFetch();
    await openEditor();

    fireEvent.click(screen.getByLabelText('Only my bindings'));
    fireEvent.click(screen.getByTestId('mock-correlation-add-binding'));
    fireEvent.click(screen.getByTestId('mock-correlation-save'));

    const rowErrors = await screen.findByTestId('mock-correlation-binding-0-errors');
    expect(within(rowErrors).getByText(/Pick the operation/)).toBeInTheDocument();
    expect(bodyOf('PUT')).toBeUndefined();
  });

  it('attaches a REST 422 to the row that caused it', async () => {
    mockFetch({
      correlation: {
        mode: 'explicit',
        operations: {
          'GET /pets/{petId}': { '/id': '{{request.path.petId}}', '/ref': '{{request.query.ref}}' },
        },
      },
      put: {
        ok: false,
        json: {
          success: false,
          error: 'Response correlation failed validation.',
          errors: [
            "Correlation, operation 'GET /pets/{petId}', pointer '/ref': unknown template root 'query'.",
          ],
        },
      },
    });
    await openEditor();

    fireEvent.click(screen.getByTestId('mock-correlation-save'));

    const rowErrors = await screen.findByTestId('mock-correlation-binding-1-errors');
    expect(within(rowErrors).getByText(/unknown template root/)).toBeInTheDocument();
    expect(screen.queryByTestId('mock-correlation-binding-0-errors')).not.toBeInTheDocument();
  });

  it('refuses bindings saved with correlation off, at block level', async () => {
    mockFetch({
      correlation: {
        mode: 'explicit',
        operations: { 'GET /pets/{petId}': { '/id': '{{request.path.petId}}' } },
      },
    });
    await openEditor();

    fireEvent.click(screen.getByLabelText('Off'));
    fireEvent.click(screen.getByTestId('mock-correlation-save'));

    const blockErrors = await screen.findByTestId('mock-correlation-block-errors');
    expect(within(blockErrors).getByText(/would never run/)).toBeInTheDocument();
    expect(bodyOf('PUT')).toBeUndefined();
  });
});

describe('the live preview', () => {
  it('renders the unsaved draft and shows the decision trace', async () => {
    mockFetch();
    await openEditor();

    fireEvent.click(screen.getByLabelText('Match path parameters'));
    fireEvent.click(screen.getByTestId('mock-correlation-preview-panel-render'));

    await waitFor(() =>
      expect(screen.getByTestId('mock-correlation-preview-panel-result')).toBeInTheDocument()
    );

    // The mode on screen is what was rendered, and nothing was saved to get there.
    expect(bodyOf('POST')).toEqual({
      projectId: 'proj-1',
      request: {
        method: 'GET',
        path: '/pets/42',
        headers: {},
        query: {},
      },
      settings: { correlation: { mode: 'path-params', operations: {} } },
    });
    expect(bodyOf('PUT')).toBeUndefined();

    const trace = screen.getByTestId('mock-correlation-preview-panel-trace');
    expect(within(trace).getByText('Correlation')).toBeInTheDocument();
    expect(within(trace).getByText(/rewrote the GET/)).toBeInTheDocument();
    expect(screen.getByTestId('mock-correlation-preview-panel-body')).toHaveTextContent('"id": 42');
  });

  it('prefills the request from the selected operation', async () => {
    mockFetch();
    await openEditor();

    expect(screen.getByLabelText('Preview request path')).toHaveValue('/pets/42');

    fireEvent.click(screen.getByLabelText('Preview operation'));
    fireEvent.click(await screen.findByRole('option', { name: 'POST /pets' }));

    await waitFor(() => expect(screen.getByLabelText('Preview request path')).toHaveValue('/pets'));
    expect(screen.getByLabelText('Preview request method')).toHaveValue('POST');
    expect(screen.getByLabelText('Preview request body')).toHaveValue('{\n  "name": "sample"\n}');
  });

  it('reports why a preview could not run instead of showing a stale answer', async () => {
    mockFetch({
      preview: {
        ok: false,
        json: { success: false, error: 'Mock preview is not configured on this deployment.' },
      },
    });
    await openEditor();

    fireEvent.click(screen.getByTestId('mock-correlation-preview-panel-render'));

    const errors = await screen.findByTestId('mock-correlation-preview-panel-errors');
    expect(within(errors).getByText(/not configured/)).toBeInTheDocument();
    expect(screen.queryByTestId('mock-correlation-preview-panel-result')).not.toBeInTheDocument();
  });
});

describe('degrading when the catalogue is unavailable', () => {
  it('opens even when the catalogue request never lands', async () => {
    // A bare `Promise.all` would reject here and lose the correlation block that did arrive.
    (global.fetch as jest.Mock).mockImplementation(async (url: string) => {
      if (String(url).includes('/mock/operations')) throw new Error('offline');
      return {
        ok: true,
        json: async () => ({
          success: true,
          correlation: { mode: 'explicit', operations: { 'GET /pets': { '/id': '{{random.uuid()}}' } } },
        }),
      };
    });
    await openEditor();

    expect(screen.getByLabelText('Only my bindings')).toBeChecked();
    expect(screen.getByLabelText('Binding 1 operation')).toHaveValue('GET /pets');
  });

  it('still edits the stored block, with a free-text operation field', async () => {
    mockFetch({
      correlation: { mode: 'explicit', operations: { 'GET /pets': { '/id': '{{random.uuid()}}' } } },
      operations: { ok: false, json: { success: false, error: 'nope' } },
    });
    await openEditor();

    expect(screen.getByLabelText('Binding 1 operation')).toHaveValue('GET /pets');
    expect(screen.getByLabelText('Binding 1 expression')).toHaveValue('{{random.uuid()}}');
  });
});

describe('accessibility', () => {
  it('has no axe violations on the mode cards and the row editor', async () => {
    mockFetch({
      correlation: {
        mode: 'inferred',
        operations: { 'GET /pets/{petId}': { '/id': '{{request.path.petId}}' } },
      },
    });
    const { baseElement } = render(<MockCorrelationEditor {...baseProps} />);
    await waitFor(() => expect(screen.getByTestId('mock-correlation-modes')).toBeInTheDocument());

    // The bindings preview, the row editor, an open token picker and the preview panel are all
    // on screen at once — the state with the most nesting inside a chosen mode card.
    fireEvent.click(
      within(screen.getByTestId('mock-correlation-binding-0-tokens')).getByRole('button', {
        name: 'Insert a token into binding 1',
      })
    );

    expect(await axe(baseElement, AXE_OPTIONS)).toHaveNoViolations();
  });

  it('keeps the mode card’s nested controls out of the radio’s label', async () => {
    mockFetch();
    await openEditor();
    fireEvent.click(screen.getByLabelText('Match path parameters'));

    // The card is a `<div>`; only its title labels the radio, so the bindings preview inside the
    // chosen card is readable and scrollable rather than swallowed by the label.
    const card = screen.getByTestId('mock-correlation-mode-path-params');
    expect(card.tagName).toBe('DIV');
    const label = within(card).getByText('Match path parameters');
    expect(label.tagName).toBe('LABEL');
    expect(
      label.contains(screen.getByTestId('mock-correlation-inferred-path-params'))
    ).toBe(false);
  });
});

/* -------------------------------------------------------------------------
   The browser fixture
   ------------------------------------------------------------------------- */

/**
 * `e2e/hive-mock-correlation.spec.ts` measures this dialog in a real browser — no horizontal
 * document scroll at 1280 px across every theme and font scale, each scrolling box owning its own
 * overflow, and axe with contrast actually computed. That markup is written here, from the very
 * render this suite pins, into `e2e/fixtures/hive-mock-correlation/` when
 * `MOCK_CORRELATION_FIXTURE_DUMP=1` is set:
 *
 *     MOCK_CORRELATION_FIXTURE_DUMP=1 npx jest -c jest.config.ts \
 *       tests/mock-correlation-editor.test.tsx -t fixture
 *
 * Without the variable the test still runs and still asserts the surface is there, so a component
 * change that would leave the fixture stale fails loudly here before it fails quietly in the
 * browser.
 */
describe('the browser fixture', () => {
  const OUT = path.join(__dirname, '..', 'e2e', 'fixtures', 'hive-mock-correlation');
  const dump = process.env.MOCK_CORRELATION_FIXTURE_DUMP === '1';

  it('renders the fullest state the browser spec mounts (and writes the fixture on request)', async () => {
    mockFetch({
      correlation: {
        mode: 'inferred',
        operations: {
          'GET /pets/{petId}': { '/id': '{{request.path.petId}}' },
          'POST /pets': { '/name': '{{request.body#/name}}' },
        },
      },
    });
    render(<MockCorrelationEditor {...baseProps} />);
    await waitFor(() => expect(screen.getByTestId('mock-correlation-modes')).toBeInTheDocument());

    // Every part on screen at once: the chosen card with its bindings preview, two binding rows,
    // an open token picker, and a rendered preview with its trace.
    fireEvent.click(
      within(screen.getByTestId('mock-correlation-binding-0-tokens')).getByRole('button', {
        name: 'Insert a token into binding 1',
      })
    );
    fireEvent.click(screen.getByTestId('mock-correlation-preview-panel-render'));
    await screen.findByTestId('mock-correlation-preview-panel-result');

    const dialog = screen.getByTestId('mock-correlation-editor-rev-1');
    const html = dialog.outerHTML;
    expect(html.length).toBeGreaterThan(0);
    if (!dump) return;
    fs.mkdirSync(OUT, { recursive: true });
    fs.writeFileSync(path.join(OUT, 'correlation-dialog.html'), html);
  });
});
