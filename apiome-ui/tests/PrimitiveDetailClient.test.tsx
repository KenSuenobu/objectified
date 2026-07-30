/**
 * Type detail page (#3468).
 *
 * Verifies the read-only registry-type detail renders schema, resolved refs,
 * dependents (graceful empty-state), metadata, base chain, and the export action.
 */

import React from 'react';
import { render, screen, waitFor, fireEvent, within } from '@testing-library/react';
import '@testing-library/jest-dom';

const mockPush = jest.fn();
jest.mock('next/navigation', () => ({
  useParams: () => ({ id: 'prim-1' }),
  useRouter: () => ({ push: mockPush }),
}));

// The JSON Schema panel renders through the shared read-only Monaco viewer; Monaco itself needs
// workers jsdom has no use for, so stub it to a textarea holding the same text (the precedent set
// by `catalog-item-detail.test.tsx`). The viewer's own container/props are still asserted below.
jest.mock('@monaco-editor/react', () => ({
  __esModule: true,
  default: (props: { value?: string }) => <textarea readOnly value={props.value ?? ''} />,
}));

import PrimitiveDetailClient from '../src/app/ade/dashboard/primitives/[id]/PrimitiveDetailClient';

const SYSTEM_MONEY = {
  id: 'prim-1',
  name: 'money',
  description: 'A monetary amount with a currency.',
  category: 'object',
  is_system: true,
  namespace: 'std/v0/types',
  schema_id: 'https://api.apiome.dev/types/std/v0/types/money',
  base_uri: 'https://api.apiome.dev/types/std/v0/types/',
  draft: '2020-12',
  source: 'system',
  usage_count: 11,
  created_at: '2025-11-02T00:00:00.000Z',
  refs: [
    { relative_ref: './decimal', resolved_target: 'std/v0/types/decimal', status: 'resolved' },
    { relative_ref: './currency-code', resolved_target: 'std/v0/types/currency-code', status: 'unresolved' },
  ],
  schema: {
    $id: 'https://api.apiome.dev/types/std/v0/types/money',
    type: 'object',
    properties: {
      amount: { $ref: './decimal' },
      currency: { type: 'string', examples: ['USD'] },
    },
    required: ['amount', 'currency'],
  },
};

function mockFetchOk(primitive: unknown) {
  global.fetch = jest.fn().mockResolvedValue({
    ok: true,
    json: async () => ({ success: true, primitive }),
  }) as unknown as typeof fetch;
}

describe('PrimitiveDetailClient', () => {
  afterEach(() => {
    jest.restoreAllMocks();
    mockPush.mockReset();
  });

  it('renders schema, refs, metadata, base chain, and a graceful dependents empty-state', async () => {
    mockFetchOk(SYSTEM_MONEY);
    render(<PrimitiveDetailClient />);

    await waitFor(() => expect(screen.getByRole('heading', { name: 'money' })).toBeInTheDocument());

    // Reference resolution shows both edges with their status (the relative refs
    // also appear in the base-chain rail, hence getAllByText).
    expect(screen.getAllByText('./decimal').length).toBeGreaterThanOrEqual(1);
    expect(screen.getByText('std/v0/types/currency-code')).toBeInTheDocument();
    expect(screen.getByText('resolved')).toBeInTheDocument();
    expect(screen.getByText('unresolved')).toBeInTheDocument();

    // Metadata right-rail derives version root + owner; namespace appears in the
    // breadcrumb and the metadata panel.
    expect(screen.getAllByText('std/v0/types').length).toBeGreaterThanOrEqual(1);
    expect(screen.getByText('v0')).toBeInTheDocument();
    expect(screen.getAllByText('system').length).toBeGreaterThanOrEqual(1);

    // Dependents empty-state (reverse index #3477 not yet populated).
    expect(screen.getByText(/No types reference this primitive yet/i)).toBeInTheDocument();

    // System type → immutable badge + disabled Edit.
    expect(screen.getByText(/immutable \(core\)/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Edit/i })).toBeDisabled();
  });

  it('renders the JSON Schema in the syntax-highlighted read-only Monaco viewer', async () => {
    mockFetchOk(SYSTEM_MONEY);
    render(<PrimitiveDetailClient />);

    await waitFor(() => expect(screen.getByRole('heading', { name: 'money' })).toBeInTheDocument());

    // The schema panel is a Monaco viewer on the `json` language — that is what buys the
    // colour syntax highlighting — and not the old plain `<pre>` code block.
    const editor = await screen.findByTestId('primitive-detail-schema-editor');
    expect(editor).toHaveAttribute('data-language', 'json');
    expect(editor).toHaveAccessibleName(/money JSON Schema — read-only json viewer/i);

    // It holds the pretty-printed schema, not a collapsed one-liner.
    const pretty = JSON.stringify(SYSTEM_MONEY.schema, null, 2);
    expect(within(editor).getByRole('textbox')).toHaveValue(pretty);
  });

  it('shows the namespace its $id asserts, not a disagreeing stored column', async () => {
    // The column is stale/wrong; the schema's own `$id` is the authority.
    mockFetchOk({ ...SYSTEM_MONEY, namespace: 'stale/from/column' });
    render(<PrimitiveDetailClient />);

    await waitFor(() => expect(screen.getByRole('heading', { name: 'money' })).toBeInTheDocument());

    // Breadcrumb and the metadata panel both read from the derived namespace.
    expect(screen.getAllByText('std/v0/types').length).toBeGreaterThanOrEqual(2);
    expect(screen.queryByText('stale/from/column')).not.toBeInTheDocument();
    // The version root follows the same source, so the two rows cannot disagree.
    expect(screen.getByText('v0')).toBeInTheDocument();
  });

  it('falls back to the stored namespace when the $id is outside the registry mount', async () => {
    mockFetchOk({
      ...SYSTEM_MONEY,
      namespace: 'tenant/acme/v1/payments',
      schema_id: 'https://x.example/base/charge',
      schema: { $id: 'https://x.example/base/charge', type: 'object' },
    });
    render(<PrimitiveDetailClient />);

    await waitFor(() => expect(screen.getByRole('heading', { name: 'money' })).toBeInTheDocument());

    // An explicit `base_uri` makes the id → namespace mapping lossy, so the column stands in.
    expect(screen.getAllByText('tenant/acme/v1/payments').length).toBeGreaterThanOrEqual(1);
  });

  it('copies the schema to the clipboard from the card header, acknowledging the write', async () => {
    mockFetchOk(SYSTEM_MONEY);
    const writeText = jest.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });

    render(<PrimitiveDetailClient />);
    await waitFor(() => expect(screen.getByRole('heading', { name: 'money' })).toBeInTheDocument());

    fireEvent.click(screen.getByTestId('primitive-detail-schema-copy'));

    // The clipboard gets the same pretty-printed document the export writes to disk.
    await waitFor(() => expect(writeText).toHaveBeenCalledWith(JSON.stringify(SYSTEM_MONEY.schema, null, 2)));
    await waitFor(() => expect(screen.getByTestId('primitive-detail-schema-copy')).toHaveTextContent('Copied'));
  });

  it('reports a failed clipboard write instead of claiming success', async () => {
    mockFetchOk(SYSTEM_MONEY);
    // Insecure context / denied permission — the promise rejects.
    const writeText = jest.fn().mockRejectedValue(new Error('denied'));
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });

    render(<PrimitiveDetailClient />);
    await waitFor(() => expect(screen.getByRole('heading', { name: 'money' })).toBeInTheDocument());

    fireEvent.click(screen.getByTestId('primitive-detail-schema-copy'));

    await waitFor(() => expect(screen.getByTestId('primitive-detail-schema-copy')).toHaveTextContent('Copy failed'));
  });

  it('downloads the schema from the card header button', async () => {
    mockFetchOk(SYSTEM_MONEY);
    const createObjectURL = jest.fn().mockReturnValue('blob:mock');
    const revokeObjectURL = jest.fn();
    (URL as unknown as { createObjectURL: unknown }).createObjectURL = createObjectURL;
    (URL as unknown as { revokeObjectURL: unknown }).revokeObjectURL = revokeObjectURL;
    const clickSpy = jest.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
    const downloadNames: string[] = [];
    jest
      .spyOn(HTMLAnchorElement.prototype, 'download', 'set')
      .mockImplementation(function (this: HTMLAnchorElement, value: string) {
        downloadNames.push(value);
      });

    render(<PrimitiveDetailClient />);
    await waitFor(() => expect(screen.getByRole('heading', { name: 'money' })).toBeInTheDocument());

    fireEvent.click(screen.getByTestId('primitive-detail-schema-download'));

    expect(createObjectURL).toHaveBeenCalledTimes(1);
    expect(clickSpy).toHaveBeenCalledTimes(1);
    expect(revokeObjectURL).toHaveBeenCalledWith('blob:mock');
    // Same filename the header's Export action produces — both go through one path.
    expect(downloadNames).toEqual(['money.schema.json']);
  });

  it('exports the schema as a downloadable JSON file', async () => {
    mockFetchOk(SYSTEM_MONEY);
    const createObjectURL = jest.fn().mockReturnValue('blob:mock');
    const revokeObjectURL = jest.fn();
    (URL as unknown as { createObjectURL: unknown }).createObjectURL = createObjectURL;
    (URL as unknown as { revokeObjectURL: unknown }).revokeObjectURL = revokeObjectURL;
    const clickSpy = jest.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});

    render(<PrimitiveDetailClient />);
    await waitFor(() => expect(screen.getByRole('heading', { name: 'money' })).toBeInTheDocument());

    fireEvent.click(screen.getByRole('button', { name: /Export/i }));
    expect(createObjectURL).toHaveBeenCalledTimes(1);
    expect(clickSpy).toHaveBeenCalledTimes(1);
    expect(revokeObjectURL).toHaveBeenCalledWith('blob:mock');
  });

  it('lists dependents when the reverse index returns them', async () => {
    mockFetchOk({
      ...SYSTEM_MONEY,
      dependents: [
        { schema_id: 'a', namespace: 'tenant/acme/v1/payments', name: 'charge', property: 'amount', scope: 'tenant', tenant_label: 'acme' },
      ],
    });
    render(<PrimitiveDetailClient />);

    await waitFor(() => expect(screen.getByRole('heading', { name: 'money' })).toBeInTheDocument());
    const dependentsTable = screen.getByText('tenant/acme/v1/payments/charge').closest('table');
    expect(dependentsTable).not.toBeNull();
    expect(within(dependentsTable as HTMLElement).getByText('amount')).toBeInTheDocument();
    expect(within(dependentsTable as HTMLElement).getByText(/Tenant · acme/i)).toBeInTheDocument();
  });

  it('shows an error alert when the primitive fails to load', async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: false,
      json: async () => ({ success: false, error: 'Primitive not found' }),
    }) as unknown as typeof fetch;
    render(<PrimitiveDetailClient />);

    await waitFor(() => expect(screen.getByText('Primitive not found')).toBeInTheDocument());
  });
});

describe('PrimitiveDetailClient — following a reference', () => {
  /**
   * `money` references `./decimal` (resolved, so the API annotated it with the target's identity)
   * and `./currency-code` (unresolved, so there is no target to open).
   */
  const MONEY_WITH_TARGETS = {
    ...SYSTEM_MONEY,
    refs: [
      {
        relative_ref: './decimal',
        resolved_target: 'https://api.apiome.dev/types/std/v0/types/decimal',
        status: 'resolved',
        target_id: 'p-decimal',
        target_name: 'decimal',
      },
      {
        relative_ref: './currency-code',
        resolved_target: 'https://api.apiome.dev/types/std/v0/types/currency-code',
        status: 'unresolved',
        target_id: null,
        target_name: null,
      },
    ],
  };

  afterEach(() => {
    jest.restoreAllMocks();
    mockPush.mockReset();
  });

  async function renderDetail(primitive: unknown = MONEY_WITH_TARGETS) {
    mockFetchOk(primitive);
    render(<PrimitiveDetailClient />);
    await waitFor(() => expect(screen.getByRole('heading', { name: 'money' })).toBeInTheDocument());
  }

  it('links a resolved $ref in Reference resolution to the type it points at', async () => {
    await renderDetail();

    const link = screen.getByTestId('ref-edge-link-0');
    expect(link).toHaveAttribute('href', '/ade/dashboard/primitives/p-decimal');
    expect(link).toHaveTextContent('./decimal');
    expect(link).toHaveAccessibleName('View details for decimal');
  });

  it('leaves an unresolved $ref as plain text', async () => {
    await renderDetail();

    // Edge 1 is unresolved — no target row exists, so there is nothing to open.
    expect(screen.queryByTestId('ref-edge-link-1')).not.toBeInTheDocument();
    // The $ref is still shown, just not linked.
    expect(screen.getAllByText('./currency-code').length).toBeGreaterThanOrEqual(1);
  });

  it('links the matching step in the base chain rail', async () => {
    await renderDetail();

    // Index 0 is the chain head (the type itself); the first ref step is index 1.
    expect(screen.queryByTestId('base-chain-link-0')).not.toBeInTheDocument();
    const step = screen.getByTestId('base-chain-link-1');
    expect(step).toHaveAttribute('href', '/ade/dashboard/primitives/p-decimal');
    expect(step).toHaveTextContent('./decimal');
  });

  it('does not link the unresolved step in the base chain', async () => {
    await renderDetail();
    expect(screen.queryByTestId('base-chain-link-2')).not.toBeInTheDocument();
  });

  it('degrades to plain text when the API sends edges without target identity', async () => {
    // An older payload (or a response predating target annotation) must still render.
    await renderDetail(SYSTEM_MONEY);

    expect(screen.queryByTestId('ref-edge-link-0')).not.toBeInTheDocument();
    expect(screen.queryByTestId('base-chain-link-1')).not.toBeInTheDocument();
    expect(screen.getAllByText('./decimal').length).toBeGreaterThanOrEqual(1);
  });
});
