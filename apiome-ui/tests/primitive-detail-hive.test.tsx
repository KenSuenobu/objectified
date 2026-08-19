/**
 * The primitive-detail redesign, rendered (HIVE-6.6, #5317).
 *
 * `primitive-detail-view.test.ts` holds the decisions this screen makes and
 * `primitive-detail-css.test.ts` pins the declarations that draw them; this holds the screen
 * itself, against the one endpoint it reads. What it pins is the ticket's four acceptance
 * criteria and the parts of the mockup's **Notes → Keeps (1:1)** list that only exist once the
 * page is assembled:
 *
 *   1. **System types show the immutable badge and a disabled Edit with its reason.** Both
 *      halves, because either alone is a screen that looks editable or one that refuses without
 *      saying why.
 *   2. **Dependents and used-in counts are unchanged.** The reverse index sends one row per
 *      referencing edge, so three rows over two types is three rows here and *two* dependent
 *      types in the aside — the de-duplication `summarizeUsage` has always done.
 *   3. **Live validation gives the same verdicts as today, including the loose-validation
 *      caveat.** The wording is pinned in the view suite; what is pinned here is that the caveat
 *      reaches the screen when a `$ref` cannot be resolved in the browser.
 *   4. **The schema pane respects the theme and the font scale** — it asks for the Hive palette
 *      rather than Monaco's `vs-dark`, and its box is a `rem` length rather than a pixel one.
 *
 * It also carries the cases the pre-Hive suite pinned for #3468 / #3477 — the namespace an `$id`
 * asserts, the two export paths, and the three places a resolved reference becomes a link — which
 * this ticket must not change.
 *
 * Plus the page chrome DESIGN.md §5.3 asks for: one breadcrumb, one `h1`, and no primary action
 * on a page whose every verb is secondary.
 */

import * as fs from 'fs';
import * as path from 'path';
import React from 'react';
import { render, screen, waitFor, fireEvent, within } from '@testing-library/react';
import '@testing-library/jest-dom';

const mockPush = jest.fn();
jest.mock('next/navigation', () => ({
  useParams: () => ({ id: 'prim-1' }),
  useRouter: () => ({ push: mockPush }),
}));

// The schema pane renders through the shared read-only Monaco viewer; Monaco itself needs workers
// jsdom has no use for, so stub it to a textarea holding the same text (the precedent set by
// `catalog-item-detail.test.tsx`). The stub keeps the props the pane is judged on — the theme id,
// the box height and the editor's accessible name — so all three stay assertable *and* the markup
// this suite dumps for `e2e/hive-primitive-detail.spec.ts` carries the label the real editor puts
// on its own textarea. Drop the `aria-label` and axe reports an unlabelled form field in the
// browser that no reader would ever meet.
jest.mock('@monaco-editor/react', () => ({
  __esModule: true,
  default: (props: {
    value?: string;
    theme?: string;
    height?: string | number;
    options?: { ariaLabel?: string };
  }) => (
    <textarea
      readOnly
      value={props.value ?? ''}
      aria-label={props.options?.ariaLabel}
      data-theme={props.theme}
      data-height={props.height}
    />
  ),
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
    {
      relative_ref: './currency-code',
      resolved_target: 'std/v0/types/currency-code',
      status: 'unresolved',
    },
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

/** A tenant type — editable, so the other half of every scope decision is covered. */
const TENANT_MONEY = {
  ...SYSTEM_MONEY,
  id: 'prim-2',
  is_system: false,
  namespace: 'tenant/acme/v1/types',
  schema_id: 'https://api.apiome.dev/types/tenant/acme/v1/types/money',
  base_uri: 'https://api.apiome.dev/types/tenant/acme/v1/types/',
  source: 'human',
  schema: {
    $id: 'https://api.apiome.dev/types/tenant/acme/v1/types/money',
    type: 'object',
    properties: {
      amount: { type: 'string', pattern: '^-?\\d+(\\.\\d{1,4})?$' },
      currency: { $ref: '../../../std/v0/types/currency-code' },
      note: { type: 'string', maxLength: 140 },
    },
    required: ['amount', 'currency'],
    additionalProperties: false,
  },
};

function mockFetchOk(primitive: unknown) {
  global.fetch = jest.fn().mockResolvedValue({
    ok: true,
    json: async () => ({ success: true, primitive }),
  }) as unknown as typeof fetch;
}

/** Render the screen and wait for the type's own `h1`. */
async function renderDetail(primitive: unknown = SYSTEM_MONEY) {
  mockFetchOk(primitive);
  const view = render(<PrimitiveDetailClient />);
  await waitFor(() =>
    expect(screen.getByRole('heading', { level: 1, name: /money/ })).toBeInTheDocument()
  );
  return view;
}

/** The reference-resolution table, by its accessible name. */
const refsTable = () => screen.getByRole('table', { name: 'Reference resolution' });
/** The dependents table, likewise. */
const dependentsTable = () => screen.getByRole('table', { name: 'Dependents' });

describe('the page chrome', () => {
  afterEach(() => {
    jest.restoreAllMocks();
    mockPush.mockReset();
  });

  it('draws one breadcrumb ending at the namespace, and exactly one h1', async () => {
    await renderDetail();

    const crumbs = within(screen.getByTestId('page-breadcrumb')).getAllByRole('listitem');
    expect(crumbs.map((item) => item.textContent?.trim())).toEqual([
      'Home',
      'Build',
      'Primitives & types',
      'std/v0/types',
    ]);
    expect(screen.getAllByRole('heading', { level: 1 })).toHaveLength(1);
  });

  it('names the type in the h1 and its scope, type and dialect beside it', async () => {
    await renderDetail();

    expect(screen.getByRole('heading', { level: 1, name: /money/ })).toBeInTheDocument();
    expect(screen.getByTestId('primitive-detail-badge-scope')).toHaveTextContent('System · core');
    expect(screen.getByTestId('primitive-detail-badge-category')).toHaveTextContent('object');
    expect(screen.getByTestId('primitive-detail-badge-draft')).toHaveTextContent('draft 2020-12');
  });

  it('gives the page no primary action — every verb here is secondary', async () => {
    await renderDetail();

    const actions = within(screen.getByTestId('page-header-actions')).getAllByRole('button', {
      hidden: true,
    });
    // Edit is a disabled `button` for a system type; Export and Deprecate are always buttons.
    expect(actions.map((action) => action.textContent?.trim())).toEqual([
      'Edit',
      'Export',
      'Deprecate',
    ]);
    for (const action of actions) {
      expect(action.className).not.toMatch(/bg-ink/);
    }
  });

  it('shows the loading region before the read lands, and the failure with a retry after', async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: false,
      json: async () => ({ success: false, error: 'Primitive not found' }),
    }) as unknown as typeof fetch;
    render(<PrimitiveDetailClient />);

    expect(await screen.findByText('Primitive not found')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /try again|retry/i })).toBeInTheDocument();
  });
});

describe('system types stay read-only', () => {
  afterEach(() => jest.restoreAllMocks());

  it('shows the immutable badge, the lock, and a disabled Edit that says why', async () => {
    await renderDetail(SYSTEM_MONEY);

    expect(screen.getByTestId('primitive-detail-badge-immutable')).toHaveTextContent(
      'immutable (core)'
    );
    expect(screen.getByTestId('primitive-detail-meta-mutability')).toHaveTextContent(
      'immutable · core'
    );

    const edit = screen.getByTestId('primitive-detail-edit');
    expect(edit).toBeDisabled();
    expect(edit).toHaveAttribute(
      'title',
      'System primitives are immutable and cannot be edited'
    );
  });

  it('sends a tenant type to the registry editor, on the id the reader is looking at', async () => {
    await renderDetail(TENANT_MONEY);

    expect(screen.queryByTestId('primitive-detail-badge-immutable')).not.toBeInTheDocument();
    const edit = screen.getByTestId('primitive-detail-edit');
    // The deep link the mockup's Keeps list calls dead: `PrimitivesManagementClient` reads it now.
    expect(edit).toHaveAttribute('href', '/ade/dashboard/primitives?edit=prim-2');
    expect(screen.getByTestId('primitive-detail-meta-mutability')).toHaveTextContent(
      'editable · tenant'
    );
  });

  it('keeps Deprecate inert, with the ticket that will make it work', async () => {
    await renderDetail(TENANT_MONEY);

    const deprecate = screen.getByTestId('primitive-detail-deprecate');
    expect(deprecate).toBeDisabled();
    expect(deprecate).toHaveAttribute('title', expect.stringContaining('#3482'));
  });
});

describe('the schema pane', () => {
  afterEach(() => jest.restoreAllMocks());

  it('paints in the Hive palette and sizes its box in rem, not pixels', async () => {
    await renderDetail();

    const pane = screen.getByTestId('primitive-detail-schema-editor');
    expect(pane).toHaveAttribute('data-language', 'json');
    expect(pane).toHaveAccessibleName(/money JSON Schema — read-only json viewer/i);

    // The theme id is the app's own, not `vs-dark`: that is what makes the pane follow all nine
    // appearances rather than only light and dark.
    const editor = within(pane).getByRole('textbox');
    expect(editor).toHaveAttribute('data-theme', 'hive');
    // And the box is a `rem` length, which is what makes it follow the font-scale preference.
    expect(editor.getAttribute('data-height')).toMatch(/^[\d.]+rem$/);
  });

  it('holds the pretty-printed schema, not a collapsed one-liner', async () => {
    await renderDetail();

    const pane = screen.getByTestId('primitive-detail-schema-editor');
    expect(within(pane).getByRole('textbox')).toHaveValue(
      JSON.stringify(SYSTEM_MONEY.schema, null, 2)
    );
  });

  it('copies the schema from the card head, acknowledging the write', async () => {
    const writeText = jest.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    await renderDetail();

    fireEvent.click(screen.getByTestId('primitive-detail-schema-copy'));

    // The clipboard gets the same document the export writes to disk.
    await waitFor(() =>
      expect(writeText).toHaveBeenCalledWith(JSON.stringify(SYSTEM_MONEY.schema, null, 2))
    );
    await waitFor(() =>
      expect(screen.getByTestId('primitive-detail-schema-copy')).toHaveTextContent('Copied')
    );
  });

  it('reports a failed clipboard write instead of claiming success', async () => {
    // Insecure context / denied permission — the promise rejects.
    const writeText = jest.fn().mockRejectedValue(new Error('denied'));
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    await renderDetail();

    fireEvent.click(screen.getByTestId('primitive-detail-schema-copy'));

    await waitFor(() =>
      expect(screen.getByTestId('primitive-detail-schema-copy')).toHaveTextContent('Copy failed')
    );
  });

  it('downloads the same file from the card head and from the header action', async () => {
    const createObjectURL = jest.fn().mockReturnValue('blob:mock');
    const revokeObjectURL = jest.fn();
    (URL as unknown as { createObjectURL: unknown }).createObjectURL = createObjectURL;
    (URL as unknown as { revokeObjectURL: unknown }).revokeObjectURL = revokeObjectURL;
    jest.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
    const downloadNames: string[] = [];
    jest
      .spyOn(HTMLAnchorElement.prototype, 'download', 'set')
      .mockImplementation(function (this: HTMLAnchorElement, value: string) {
        downloadNames.push(value);
      });

    await renderDetail();

    fireEvent.click(screen.getByTestId('primitive-detail-schema-download'));
    fireEvent.click(screen.getByTestId('primitive-detail-export'));

    expect(createObjectURL).toHaveBeenCalledTimes(2);
    expect(revokeObjectURL).toHaveBeenCalledWith('blob:mock');
    // One filename and one serialization, whichever button the reader reached for.
    expect(downloadNames).toEqual(['money.schema.json', 'money.schema.json']);
  });
});

describe('reference resolution', () => {
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

  afterEach(() => jest.restoreAllMocks());

  it('lists every edge with the shared vocabulary’s label for its status', async () => {
    await renderDetail();

    const rows = within(refsTable()).getAllByRole('row').slice(1);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toHaveTextContent('Resolved');
    expect(rows[1]).toHaveTextContent('Unresolved');
    expect(within(refsTable()).getByText('std/v0/types/currency-code')).toBeInTheDocument();
  });

  it('names the base the relative values were resolved against', async () => {
    await renderDetail();

    expect(screen.getByTestId('primitive-detail-refs-foot')).toHaveTextContent(
      'Base: https://api.apiome.dev/types/std/v0/types/'
    );
  });

  it('says so, in the card, when the type carries no relative $ref', async () => {
    await renderDetail({ ...SYSTEM_MONEY, refs: [] });

    expect(screen.getByText('No relative $ref values')).toBeInTheDocument();
    expect(screen.queryByTestId('primitive-detail-refs-foot')).toBeInTheDocument();
  });

  it('links a resolved $ref to the type it points at', async () => {
    await renderDetail(MONEY_WITH_TARGETS);

    const link = screen.getByTestId('ref-edge-link-0');
    expect(link).toHaveAttribute('href', '/ade/dashboard/primitives/p-decimal');
    expect(link).toHaveTextContent('./decimal');
    expect(link).toHaveAccessibleName('View details for decimal');
  });

  it('leaves an unresolved $ref as plain text', async () => {
    await renderDetail(MONEY_WITH_TARGETS);

    // Edge 1 is unresolved — no target row exists, so there is nothing to open.
    expect(screen.queryByTestId('ref-edge-link-1')).not.toBeInTheDocument();
    expect(within(refsTable()).getByText('./currency-code')).toBeInTheDocument();
  });

  it('links the matching step in the base chain, and never the head', async () => {
    await renderDetail(MONEY_WITH_TARGETS);

    // Index 0 is the chain head — the type being viewed — so it links nowhere.
    expect(screen.queryByTestId('base-chain-link-0')).not.toBeInTheDocument();
    const step = screen.getByTestId('base-chain-link-1');
    expect(step).toHaveAttribute('href', '/ade/dashboard/primitives/p-decimal');
    expect(step).toHaveTextContent('./decimal');
    // The unresolved hop links nowhere either, and says the word rather than only wearing amber.
    expect(screen.queryByTestId('base-chain-link-2')).not.toBeInTheDocument();
    const chain = within(screen.getByTestId('primitive-detail-base-chain')).getAllByRole(
      'listitem'
    );
    expect(chain[0]).toHaveAttribute('data-status', 'self');
    expect(chain[2]).toHaveAttribute('data-status', 'unresolved');
    expect(chain[2]).toHaveTextContent('unresolved');
  });

  it('degrades to plain text when the API sends edges without target identity', async () => {
    // An older payload (or a response predating target annotation) must still render.
    await renderDetail(SYSTEM_MONEY);

    expect(screen.queryByTestId('ref-edge-link-0')).not.toBeInTheDocument();
    expect(screen.queryByTestId('base-chain-link-1')).not.toBeInTheDocument();
    expect(within(refsTable()).getByText('./decimal')).toBeInTheDocument();
  });
});

describe('dependents and the used-in counts', () => {
  afterEach(() => jest.restoreAllMocks());

  it('lists one row per referencing edge, and counts distinct types once', async () => {
    // `charge` references `money` twice — three rows, two dependent types, one tenant.
    await renderDetail({
      ...SYSTEM_MONEY,
      usage_count: 14,
      dependents: [
        {
          id: 'p-charge',
          schema_id: 'a',
          namespace: 'tenant/acme/v1/payments',
          name: 'charge',
          property: 'amount',
          scope: 'tenant',
          tenant_label: 'acme',
        },
        {
          id: 'p-charge',
          schema_id: 'a',
          namespace: 'tenant/acme/v1/payments',
          name: 'charge',
          property: 'fee',
          scope: 'tenant',
          tenant_label: 'acme',
        },
        {
          id: 'p-decimal',
          schema_id: 'b',
          namespace: 'std/v0/types',
          name: 'decimal',
          property: null,
          scope: 'system',
        },
      ],
    });

    const rows = within(dependentsTable()).getAllByRole('row').slice(1);
    expect(rows).toHaveLength(3);
    expect(rows[0]).toHaveTextContent('tenant/acme/v1/payments/charge');
    expect(rows[0]).toHaveTextContent('amount');
    expect(rows[0]).toHaveTextContent('Tenant · acme');
    expect(rows[2]).toHaveTextContent('System · core');
    expect(screen.getByTestId('primitive-detail-dependents-foot')).toHaveTextContent(
      '3 dependents'
    );

    // The aside counts *types*, not edges — the de-duplication #3477 needs.
    expect(screen.getByTestId('primitive-detail-usage-dependent-types')).toHaveTextContent('2');
    expect(screen.getByTestId('primitive-detail-usage-properties')).toHaveTextContent('14');
    expect(screen.getByTestId('primitive-detail-usage-tenants')).toHaveTextContent('1');
  });

  it('links a dependent to its own detail page, and leaves an idless one as text', async () => {
    await renderDetail({
      ...SYSTEM_MONEY,
      dependents: [
        { id: 'p-decimal', schema_id: 'b', namespace: 'std/v0/types', name: 'decimal', scope: 'system' },
        { schema_id: 'c', name: 'legacy', scope: 'system' },
      ],
    });

    const link = screen.getByTestId('dependent-link-0');
    expect(link).toHaveAttribute('href', '/ade/dashboard/primitives/p-decimal');
    expect(link).toHaveTextContent('std/v0/types/decimal');
    expect(link).toHaveAccessibleName('View details for decimal');

    expect(screen.queryByTestId('dependent-link-1')).not.toBeInTheDocument();
    expect(within(dependentsTable()).getByText('legacy')).toBeInTheDocument();
  });

  it('teaches, in the card, when nothing references the type', async () => {
    await renderDetail(SYSTEM_MONEY);

    expect(screen.getByText('No type in view references this one')).toBeInTheDocument();
    expect(screen.queryByTestId('primitive-detail-dependents-foot')).not.toBeInTheDocument();
    expect(screen.getByTestId('primitive-detail-usage-dependent-types')).toHaveTextContent('0');
  });
});

describe('the metadata aside', () => {
  afterEach(() => jest.restoreAllMocks());

  it('reads the namespace its $id asserts, not a disagreeing stored column', async () => {
    // The column is stale/wrong; the schema's own `$id` is the authority.
    await renderDetail({ ...SYSTEM_MONEY, namespace: 'stale/from/column' });

    expect(screen.getByTestId('primitive-detail-meta-namespace')).toHaveTextContent('std/v0/types');
    expect(screen.queryByText('stale/from/column')).not.toBeInTheDocument();
    // The version root follows the same source, so the two rows cannot disagree.
    expect(screen.getByTestId('primitive-detail-meta-version-root')).toHaveTextContent('v0');
  });

  it('falls back to the stored namespace when the $id is outside the registry mount', async () => {
    await renderDetail({
      ...SYSTEM_MONEY,
      namespace: 'tenant/acme/v1/payments',
      schema_id: 'https://x.example/base/charge',
      schema: { $id: 'https://x.example/base/charge', type: 'object' },
    });

    // An explicit `base_uri` makes the id → namespace mapping lossy, so the column stands in.
    expect(screen.getByTestId('primitive-detail-meta-namespace')).toHaveTextContent(
      'tenant/acme/v1/payments'
    );
  });

  it('prints the identity, owner, source and creation date the row carries', async () => {
    await renderDetail(SYSTEM_MONEY);

    expect(screen.getByTestId('primitive-detail-meta-id')).toHaveTextContent(
      'https://api.apiome.dev/types/std/v0/types/money'
    );
    expect(screen.getByTestId('primitive-detail-meta-owner')).toHaveTextContent('system');
    expect(screen.getByTestId('primitive-detail-meta-source')).toHaveTextContent('system');
    expect(screen.getByTestId('primitive-detail-meta-created')).toHaveTextContent('2025-11-02');
    expect(screen.getByTestId('primitive-detail-meta-scope')).toHaveTextContent('System · core');
  });

  it('degrades every absent field to one em dash rather than to `undefined`', async () => {
    await renderDetail({
      ...SYSTEM_MONEY,
      namespace: null,
      schema_id: null,
      base_uri: null,
      source: undefined,
      created_at: null,
      schema: { type: 'object' },
    });

    expect(screen.getByTestId('primitive-detail-meta-id')).toHaveTextContent('—');
    expect(screen.getByTestId('primitive-detail-meta-namespace')).toHaveTextContent('—');
    expect(screen.getByTestId('primitive-detail-meta-version-root')).toHaveTextContent('—');
    expect(screen.getByTestId('primitive-detail-meta-created')).toHaveTextContent('—');
    // A missing `source` is not unknown provenance — the API's own default is `human`.
    expect(screen.getByTestId('primitive-detail-meta-source')).toHaveTextContent('human');
  });
});

describe('the test form on the page', () => {
  afterEach(() => jest.restoreAllMocks());

  it('opens collapsed, and validates live once opened', async () => {
    await renderDetail(TENANT_MONEY);

    expect(screen.getByTestId('primitive-test-toggle')).toHaveAttribute('aria-expanded', 'false');
    fireEvent.click(screen.getByTestId('primitive-test-toggle'));

    // The seeded example does not satisfy the `amount` pattern, and `currency` is an
    // unresolvable `$ref` the generator left blank — so the card opens invalid.
    expect(screen.getByTestId('primitive-test-verdict')).toHaveAttribute('data-status', 'invalid');

    fireEvent.change(screen.getByTestId('primitive-test-input-/amount'), {
      target: { value: '12.50' },
    });
    fireEvent.change(screen.getByTestId('primitive-test-input-/currency'), {
      target: { value: '"EUR"' },
    });

    expect(screen.getByTestId('primitive-test-verdict')).toHaveAttribute('data-status', 'valid');
  });

  it('carries the loose-validation caveat for a $ref it cannot resolve here', async () => {
    await renderDetail(TENANT_MONEY);
    fireEvent.click(screen.getByTestId('primitive-test-toggle'));

    expect(screen.getByTestId('primitive-test-unresolved-refs')).toHaveTextContent(
      '../../../std/v0/types/currency-code'
    );
    expect(screen.getByTestId('primitive-test-unresolved-refs')).toHaveTextContent(
      /not checked here/i
    );
  });
});

describe('the example instance', () => {
  afterEach(() => jest.restoreAllMocks());

  it('shows the generated example, and how it was chosen', async () => {
    await renderDetail(TENANT_MONEY);

    const card = screen.getByTestId('primitive-detail-example');
    // `currency` is a bare `$ref` the generator cannot follow, so it is absent by design.
    expect(card).toHaveTextContent('"amount"');
    expect(card).not.toHaveTextContent('"currency"');
    expect(card).toHaveTextContent('examples[0] → default → const → enum[0] → by type');
  });

  it('draws no card at all when no example can be produced', async () => {
    await renderDetail({
      ...SYSTEM_MONEY,
      // Every property is an unresolvable `$ref`, so there is nothing to generate.
      schema: { type: 'object', properties: { amount: { $ref: './decimal' } } },
    });

    expect(screen.queryByTestId('primitive-detail-example')).not.toBeInTheDocument();
  });
});

/**
 * `e2e/hive-primitive-detail.spec.ts` measures this screen in a real browser — no horizontal
 * document scroll across the nine themes, both densities and all six font scales, the aside's
 * fold, and axe — against markup the components actually render. That markup is written here,
 * from the very renders this suite pins, into `e2e/fixtures/hive-primitive-detail/` when
 * `PRIMITIVE_DETAIL_FIXTURE_DUMP=1` is set:
 *
 *     PRIMITIVE_DETAIL_FIXTURE_DUMP=1 npx jest -c jest.config.ts \
 *       tests/primitive-detail-hive.test.tsx -t fixtures
 *
 * Without the variable the test still runs — it renders every surface and checks each is there —
 * so a change to a component that would leave the fixtures stale fails loudly here before it
 * fails quietly in the browser.
 */
describe('the browser fixtures', () => {
  const OUT = path.join(__dirname, '..', 'e2e', 'fixtures', 'hive-primitive-detail');
  const dump = process.env.PRIMITIVE_DETAIL_FIXTURE_DUMP === '1';

  /** Write one fixture, or just assert it could be. */
  const write = (name: string, html: string) => {
    expect(html.length).toBeGreaterThan(0);
    if (!dump) return;
    fs.mkdirSync(OUT, { recursive: true });
    fs.writeFileSync(path.join(OUT, `${name}.html`), html);
  };

  /** The page column the shell would put this screen in. */
  const page = () => document.querySelector('.page') as HTMLElement;

  afterEach(() => jest.restoreAllMocks());

  it('renders every surface the browser spec mounts (and writes the fixtures on request)', async () => {
    await renderDetail({
      ...TENANT_MONEY,
      dependents: [
        {
          id: 'p-invoice',
          schema_id: 'a',
          namespace: 'tenant/acme/v1/types',
          name: 'invoice',
          property: 'total',
          scope: 'tenant',
          tenant_label: 'acme',
        },
        {
          id: 'p-order-line',
          schema_id: 'b',
          namespace: 'tenant/acme/v1/types',
          name: 'order-line',
          property: 'price',
          scope: 'tenant',
          tenant_label: 'acme',
        },
        { id: 'p-decimal', schema_id: 'c', namespace: 'std/v0/types', name: 'decimal', scope: 'system' },
      ],
      refs: [
        {
          relative_ref: '../../../std/v0/types/currency-code',
          resolved_target: 'std/v0/types/currency-code',
          status: 'resolved',
          target_id: 'p-currency',
          target_name: 'currency-code',
        },
        { relative_ref: '../legacy/decimal', status: 'unresolved' },
      ],
    });

    // Collapsed — the state a reader lands on.
    write('detail', page().outerHTML);

    // Open — the state every field row, the verdict and the findings list only exist in.
    fireEvent.click(screen.getByTestId('primitive-test-toggle'));
    await screen.findByTestId('primitive-test-verdict');
    write('detail-testing', page().outerHTML);

    // Array mode repeats the whole form per element, which is the tallest the card ever gets.
    fireEvent.click(screen.getByTestId('primitive-test-mode-array'));
    await screen.findByTestId('primitive-test-array-');
    write('detail-array', page().outerHTML);
  });

  it('renders the system variant, whose badges and lock differ', async () => {
    await renderDetail(SYSTEM_MONEY);
    await screen.findByTestId('primitive-detail-badge-immutable');
    write('detail-system', page().outerHTML);
  });
});
