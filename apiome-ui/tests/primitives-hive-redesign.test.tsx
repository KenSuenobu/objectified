/**
 * The primitives & types redesign, rendered (HIVE-6.5, #5316).
 *
 * `primitives-registry-model.test.ts` holds the decisions and `primitives-css.test.ts` pins the
 * declarations; this holds the screen that makes them, against the six endpoints it reads. What
 * it pins is the ticket's four acceptance criteria and the parts of the mockup's
 * **Notes → Keeps (1:1)** list that only exist once the screen is assembled:
 *
 *   1. **System primitives stay read-only, with the lock affordance and the explanation.**
 *      Both verbs on a `std/*` row are `disabled` and each says why.
 *   2. **Namespace precedence and promote-to-core are unchanged.** The ladder still reads
 *      tenant → vendor → core and the promotion button is still inert.
 *   3. **The resolver is reachable.** This is the mockup's one *Adds*: the KPI strip's amber
 *      tile and the rail's explainer link used to point at `?focus=resolver`, a query nothing
 *      read. Both switch panes now, and the address itself works.
 *   4. **The editor is opened by the same rows, and refused by the same ones.**
 *
 * Plus the page chrome DESIGN.md §5.3 asks for: one breadcrumb, one `h1`, one primary action,
 * and the four-tab strip in the header rather than in the body.
 */

import * as fs from 'fs';
import * as path from 'path';
import React from 'react';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import '@testing-library/jest-dom';

const mockPush = jest.fn();
const mockConfirm = jest.fn(() => Promise.resolve(false));

/** The `?focus=` value the next render sees. Reset in `beforeEach`. */
let searchParams = new URLSearchParams('');

jest.mock('next/navigation', () => ({
  useRouter: () => ({ push: mockPush, replace: jest.fn() }),
  useSearchParams: () => searchParams,
  usePathname: () => '/ade/dashboard/primitives',
}));

/** The tenant the session is scoped to; `null` for the gated case. */
let currentTenantId: string | null = 'tenant-1';

jest.mock('@lib/auth/session-client', () => ({
  useAuthSession: () => ({
    data: { user: { current_tenant_id: currentTenantId ?? undefined } },
    status: 'authenticated',
  }),
}));

jest.mock('@/app/components/providers/DialogProvider', () => ({
  useDialog: () => ({ confirm: (options: unknown) => mockConfirm(options as never) }),
}));

// Page-level outcomes go to the app-wide toaster; a stub keeps them out of the DOM and makes the
// refusals assertable.
jest.mock('sonner', () => ({
  __esModule: true,
  toast: Object.assign(jest.fn(), { success: jest.fn(), error: jest.fn() }),
}));

import { toast } from 'sonner';

import PrimitivesManagementClient from '../src/app/ade/dashboard/primitives/PrimitivesManagementClient';

const PRIMITIVES = [
  {
    id: 'p-currency',
    tenant_id: 'tenant-1',
    name: 'currency-code',
    description: 'ISO 4217 three-letter currency code, upper case.',
    category: 'string',
    schema: {},
    tags: [],
    created_by: null,
    is_system: true,
    is_public: true,
    usage_count: 22,
    enabled: true,
    namespace: 'std/v0/types',
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-01T00:00:00Z',
  },
  {
    id: 'p-money',
    tenant_id: 'tenant-1',
    name: 'money',
    description: 'Monetary amount with currency.',
    category: 'object',
    schema: {},
    tags: [],
    created_by: null,
    is_system: false,
    is_public: false,
    usage_count: 14,
    enabled: true,
    namespace: 'tenant/acme/v1/types',
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-01T00:00:00Z',
  },
];

const NAMESPACES = [
  {
    id: 'ns-std',
    tenant_id: null,
    namespace: 'std/v0/types',
    base_uri: 'https://api.apiome.dev/types/std/v0/types/',
    version_root: 'v0',
    description: 'Seeded core types',
    scope: 'system',
    is_system: true,
    is_public: true,
    is_default: false,
    type_count: 15,
  },
  {
    id: 'ns-acme',
    tenant_id: 'tenant-1',
    namespace: 'tenant/acme/v1/types',
    base_uri: 'https://api.apiome.dev/types/tenant/acme/v1/types/',
    version_root: 'v1',
    description: 'Acme business types',
    scope: 'tenant',
    is_system: false,
    is_public: false,
    is_default: true,
    type_count: 12,
  },
];

const STATS = {
  core_type_count: 24,
  tenant_type_count: 17,
  imported_count: 6,
  properties_bound_count: 88,
  bound_class_count: 31,
  unresolved_ref_count: 3,
  namespace_count: 3,
};

const IMPORTS = [
  {
    id: 'imp-1',
    tenant_id: 'tenant-1',
    source_kind: 'type-def-bundle',
    source_label: 'acme-types-bundle.json',
    target_namespace: 'tenant/acme/v1/types',
    imported_count: 12,
    skipped_count: 0,
    error_count: 0,
    created_at: '2026-08-18T10:00:00Z',
  },
];

/** A resolver response with one resolved and one unresolved edge, for the browser fixture. */
const RESOLVED = {
  success: true,
  resolve: {
    total_primitives: 1,
    ref_count: 2,
    resolved_ref_count: 1,
    unresolved_ref_count: 1,
    affected_primitive_count: 1,
    reresolved_primitive_count: 0,
    primitives: [
      {
        id: 'p-money',
        name: 'money',
        namespace: 'tenant/acme/v1/types',
        base_uri: 'https://api.apiome.dev/types/tenant/acme/v1/types/',
        ref_count: 2,
        resolved_count: 1,
        unresolved_count: 1,
        refs: [
          {
            relative_ref: '../../../std/v0/types/currency-code',
            resolved_target: 'https://api.apiome.dev/types/std/v0/types/currency-code',
            status: 'resolved',
            target_id: 'p-currency',
            target_name: 'currency-code',
          },
          {
            relative_ref: '../../vendor/stripe/v2/price',
            resolved_target: null,
            status: 'unresolved',
            target_id: null,
            target_name: null,
          },
        ],
      },
    ],
  },
};

/** Every endpoint the screen reads, keyed by the path it is fetched from. */
const PAYLOADS: Record<string, unknown> = {
  '/api/primitives': { success: true, primitives: PRIMITIVES },
  '/api/primitives/stats': { success: true, stats: STATS },
  '/api/types/namespaces': { success: true, namespaces: NAMESPACES },
  '/api/primitives/imports?limit=8': { success: true, imports: IMPORTS },
  '/api/primitives/unresolved': { success: true, unresolved: { primitives: [] } },
  '/api/types/resolve': { success: true, resolve: { primitives: [], ref_count: 0, reresolved_primitive_count: 0 } },
  '/api/types/settings': { success: true, settings: { is_default: true } },
  '/api/primitives/health': {
    success: true,
    health: { connection: 'connected', status: 'healthy', storage_present: true },
  },
};

function mockFetch() {
  return jest.fn((url: string) =>
    Promise.resolve({
      ok: true,
      status: 200,
      text: async () => '',
      json: async () => PAYLOADS[url] ?? { success: true },
    })
  );
}

/** Render the screen and wait for the first read to land. */
async function renderScreen() {
  global.fetch = mockFetch() as unknown as typeof fetch;
  const view = render(<PrimitivesManagementClient />);
  await waitFor(() => expect(screen.getByRole('table', { name: 'Primitives' })).toBeInTheDocument());
  return view;
}

/** One row of the types table, by the id `DataTable` stamps on it. */
function typeRow(id: string): HTMLTableRowElement {
  return document.querySelector(`tr[data-row-id="${id}"]`) as HTMLTableRowElement;
}

beforeEach(() => {
  searchParams = new URLSearchParams('');
  currentTenantId = 'tenant-1';
  mockPush.mockClear();
  mockConfirm.mockClear();
  (toast.error as jest.Mock).mockClear();
  (toast.success as jest.Mock).mockClear();
});

afterEach(() => jest.restoreAllMocks());

describe('the page chrome', () => {
  it('draws one breadcrumb, one h1 and the mockup’s two header actions', async () => {
    await renderScreen();

    const crumbs = screen.getByTestId('page-breadcrumb');
    expect(within(crumbs).getByText('Build')).toBeInTheDocument();
    expect(within(crumbs).getByText('Primitives & types')).toBeInTheDocument();

    expect(screen.getByRole('heading', { level: 1, name: 'Primitives & types' })).toBeInTheDocument();
    expect(screen.getByTestId('primitives-import')).toHaveTextContent('Import from schema');
    expect(screen.getByTestId('primitives-create')).toHaveTextContent('Create primitive');
  });

  it('puts the four panes in the header’s tab strip, in the mockup’s order', async () => {
    await renderScreen();

    const strip = screen.getByRole('tablist', { name: 'Primitives views' });
    expect(within(strip).getAllByRole('tab').map((tab) => tab.textContent)).toEqual([
      'Registry',
      'Namespaces & scopes',
      'Resolver',
      'Settings',
    ]);
    expect(screen.getByTestId('primitives-tab-registry')).toHaveAttribute('aria-selected', 'true');
  });

  it('refuses to draw anything without a workspace, and says why', async () => {
    currentTenantId = null;
    global.fetch = mockFetch() as unknown as typeof fetch;
    render(<PrimitivesManagementClient />);

    expect(screen.getByText(/select a tenant to manage primitives/i)).toBeInTheDocument();
    expect(screen.queryByRole('table', { name: 'Primitives' })).not.toBeInTheDocument();
    // The two header verbs are offered but inert, rather than missing.
    expect(screen.getByTestId('primitives-create')).toBeDisabled();
  });
});

describe('the KPI strip and the resolver deep link', () => {
  it('draws the five tiles from the stats endpoint', async () => {
    await renderScreen();

    const strip = await screen.findByTestId('primitives-kpis');
    expect(within(strip).getByTestId('primitives-kpi-core')).toHaveTextContent('24');
    expect(within(strip).getByTestId('primitives-kpi-core')).toHaveTextContent('std/* · all tenants');
    expect(within(strip).getByTestId('primitives-kpi-tenant')).toHaveTextContent('3 namespaces');
    expect(within(strip).getByTestId('primitives-kpi-bound')).toHaveTextContent('across 31 classes');
  });

  it('makes the unresolved tile a button that opens the resolver', async () => {
    // The mockup's one "Adds": this used to be a `next/link` to `?focus=resolver`, and nothing
    // on the screen read that parameter — the link appeared to do nothing at all.
    await renderScreen();

    const tile = await screen.findByTestId('primitives-kpi-unresolved');
    expect(tile.tagName).toBe('BUTTON');

    fireEvent.click(tile);

    expect(screen.getByTestId('primitives-tab-resolver')).toHaveAttribute('aria-selected', 'true');
    expect(screen.queryByRole('table', { name: 'Primitives' })).not.toBeInTheDocument();
  });

  it('opens the resolver from the rail’s explainer link as well', async () => {
    await renderScreen();

    fireEvent.click(screen.getByTestId('primitives-open-resolver-rail'));

    expect(screen.getByTestId('primitives-tab-resolver')).toHaveAttribute('aria-selected', 'true');
  });

  it('honours ?focus= in the address bar, so the old link still resolves', async () => {
    searchParams = new URLSearchParams('focus=resolver');
    global.fetch = mockFetch() as unknown as typeof fetch;
    render(<PrimitivesManagementClient />);

    expect(screen.getByTestId('primitives-tab-resolver')).toHaveAttribute('aria-selected', 'true');
  });

  it('ignores a ?focus= naming no pane', async () => {
    searchParams = new URLSearchParams('focus=nonsense');
    global.fetch = mockFetch() as unknown as typeof fetch;
    render(<PrimitivesManagementClient />);

    expect(screen.getByTestId('primitives-tab-registry')).toHaveAttribute('aria-selected', 'true');
  });

  it('opens the editor on the type ?edit= names (HIVE-6.6, #5317)', async () => {
    // The type-detail page's Edit action links here with `?edit=<id>`; before #5317 nothing read
    // it, so the reader landed on an unfiltered list instead of on the type they were viewing.
    searchParams = new URLSearchParams('edit=p-money');
    await renderScreen();

    expect(await screen.findByRole('heading', { name: 'Edit primitive' })).toBeInTheDocument();
  });

  it('refuses ?edit= on a system type, with the reason it refuses every other way', async () => {
    searchParams = new URLSearchParams('edit=p-currency');
    await renderScreen();

    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith('System primitives cannot be edited')
    );
    expect(screen.queryByRole('heading', { name: 'Edit primitive' })).not.toBeInTheDocument();
  });

  it('ignores an ?edit= naming no row rather than opening an empty editor', async () => {
    searchParams = new URLSearchParams('edit=p-nonexistent');
    await renderScreen();

    expect(screen.queryByRole('heading', { name: 'Edit primitive' })).not.toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'Create primitive' })).not.toBeInTheDocument();
  });
});

describe('system primitives stay read-only', () => {
  it('disables both verbs on a std/* row and says why on each', async () => {
    await renderScreen();

    const edit = screen.getByTestId('primitives-edit-p-currency');
    const remove = screen.getByTestId('primitives-delete-p-currency');
    expect(edit).toBeDisabled();
    expect(edit).toHaveAttribute('title', 'System primitives cannot be edited');
    expect(remove).toBeDisabled();
    expect(remove).toHaveAttribute('title', 'System primitives cannot be deleted');
  });

  it('leaves a tenant row’s verbs available', async () => {
    await renderScreen();

    expect(screen.getByTestId('primitives-edit-p-money')).toBeEnabled();
    expect(screen.getByTestId('primitives-delete-p-money')).toBeEnabled();
  });

  it('marks each row with the scope it belongs to', async () => {
    await renderScreen();

    expect(typeRow('p-currency')).toHaveTextContent('System');
    expect(typeRow('p-money')).toHaveTextContent('Tenant');
  });

  it('asks before deleting, naming the type and what binds it', async () => {
    await renderScreen();

    fireEvent.click(screen.getByTestId('primitives-delete-p-money'));

    await waitFor(() => expect(mockConfirm).toHaveBeenCalled());
    expect(mockConfirm).toHaveBeenCalledWith(
      expect.objectContaining({
        title: 'Delete primitive',
        message: expect.stringContaining('used in 14 places'),
        variant: 'danger',
      })
    );
  });

  it('opens a type’s page from its row', async () => {
    await renderScreen();

    fireEvent.click(within(typeRow('p-money')).getAllByRole('cell')[1]);

    expect(mockPush).toHaveBeenCalledWith('/ade/dashboard/primitives/p-money');
  });
});

describe('the collections panel filters the table below it', () => {
  it('adds a namespace chip when a collection row is chosen, and clears it again', async () => {
    await renderScreen();

    fireEvent.click(document.querySelector('tr[data-row-id="ns-acme"]') as HTMLElement);

    const chip = await screen.findByTestId('selected-namespace-chip');
    expect(chip).toHaveTextContent('Namespace: tenant/acme/v1/types');
    await waitFor(() => expect(typeRow('p-currency')).toBeNull());

    fireEvent.click(chip);

    await waitFor(() => expect(typeRow('p-currency')).not.toBeNull());
  });
});

describe('namespaces & scopes', () => {
  async function openNamespaces() {
    await renderScreen();
    fireEvent.click(screen.getByTestId('primitives-tab-namespaces'));
    await screen.findByRole('table', { name: 'Namespaces' });
  }

  it('keeps the two scope-model explainers and their base URIs', async () => {
    await openNamespaces();

    expect(screen.getByTestId('primitives-scope-system')).toHaveTextContent(
      'api.apiome.dev/types/std/'
    );
    expect(screen.getByTestId('primitives-scope-tenant')).toHaveTextContent('tenant/<slug>/*');
  });

  it('locks a system namespace and leaves a tenant one editable', async () => {
    await openNamespaces();

    const systemRow = document.querySelector('tr[data-row-id="ns-std"]') as HTMLElement;
    expect(within(systemRow).getByText('Read-only')).toBeInTheDocument();
    expect(within(systemRow).queryByText('Edit')).not.toBeInTheDocument();

    const tenantRow = document.querySelector('tr[data-row-id="ns-acme"]') as HTMLElement;
    expect(within(tenantRow).getByText('Edit')).toBeInTheDocument();
    expect(within(tenantRow).getByTestId('remove-namespace-tenant/acme/v1/types')).toBeInTheDocument();
  });

  it('marks the tenant default and prints the elided base URI', async () => {
    await openNamespaces();

    const tenantRow = document.querySelector('tr[data-row-id="ns-acme"]') as HTMLElement;
    expect(tenantRow).toHaveTextContent('default');
    expect(tenantRow).toHaveTextContent('…/types/tenant/acme/v1/types/');
  });

  it('keeps precedence most-specific first, and promotion governed', async () => {
    await openNamespaces();

    const ladder = screen.getByTestId('primitives-precedence');
    const steps = within(ladder)
      .getAllByRole('listitem')
      .map((item) => item.textContent ?? '');
    expect(steps[0]).toContain('Tenant namespace');
    expect(steps[1]).toContain('Imported vendor namespaces');
    expect(steps[2]).toContain('System core');

    const promote = screen.getByRole('button', { name: /Request promotion/i });
    expect(promote).toBeDisabled();
    expect(promote).toHaveAttribute('title', 'Requires platform administrator approval');
  });
});

describe('the primitive editor', () => {
  /** Open the create dialog over the loaded screen, and return it. */
  async function openEditor(): Promise<HTMLElement> {
    await renderScreen();
    fireEvent.click(screen.getByTestId('primitives-create'));
    await screen.findByRole('heading', { name: 'Create primitive' });
    // Scoped to the dialog: the screen behind it has its own Namespace and Type controls, and
    // an unscoped query would find those instead.
    return document.querySelector('[role="dialog"]') as HTMLElement;
  }

  it('opens on the Form tab, with both views offered', async () => {
    await openEditor();

    const strip = screen.getByRole('tablist', { name: 'Primitive editor views' });
    expect(within(strip).getAllByRole('tab').map((tab) => tab.textContent)).toEqual([
      'Form',
      'Advanced JSON',
    ]);
    expect(within(strip).getByRole('tab', { name: 'Form' })).toHaveAttribute(
      'aria-selected',
      'true'
    );
  });

  it('keeps the mockup’s form sections, and no namespace field', async () => {
    const dialog = await openEditor();

    for (const section of [
      'Basic information',
      'String constraints',
      'Validation',
      'Default & examples',
      'Schema preview',
    ]) {
      expect(
        within(dialog).getByRole('heading', { name: new RegExp(section, 'i') })
      ).toBeInTheDocument();
    }
    // The mockup is explicit: a type's namespace is not editable here.
    expect(within(dialog).queryByLabelText(/namespace/i)).not.toBeInTheDocument();
  });

  it('swaps the constraint block with the chosen type', async () => {
    const dialog = await openEditor();

    expect(within(dialog).getByLabelText('Format')).toBeInTheDocument();

    fireEvent.change(within(dialog).getByLabelText(/^Type/), { target: { value: 'boolean' } });

    expect(within(dialog).queryByLabelText('Format')).not.toBeInTheDocument();
    expect(
      within(dialog).getByText(/Boolean type has no additional constraints/i)
    ).toBeInTheDocument();
  });

  it('previews the schema the form builds, live', async () => {
    const dialog = await openEditor();

    fireEvent.change(within(dialog).getByLabelText('Min length'), { target: { value: '6' } });

    const preview = screen.getByTestId('primitive-schema-preview');
    expect(preview).toHaveTextContent('"type": "string"');
    expect(preview).toHaveTextContent('"minLength": 6');
  });

  it('collects enum values as chips, and drops one again', async () => {
    const dialog = await openEditor();

    const input = within(dialog).getByLabelText('Allowed values (enum)');
    fireEvent.change(input, { target: { value: 'work' } });
    fireEvent.keyDown(input, { key: 'Enter' });

    expect(screen.getByTestId('primitive-schema-preview')).toHaveTextContent('"work"');

    fireEvent.click(screen.getByRole('button', { name: 'Remove work' }));

    expect(screen.getByTestId('primitive-schema-preview')).not.toHaveTextContent('"work"');
  });

  it('refuses to save a type with no name', async () => {
    const dialog = await openEditor();

    fireEvent.click(within(dialog).getByRole('button', { name: 'Create' }));

    expect(await screen.findByText('Name is required')).toBeInTheDocument();
  });
});

/**
 * `e2e/hive-primitives-registry.spec.ts` measures this screen in a real browser — no horizontal
 * document scroll across the nine themes, both densities and all six font scales, and axe —
 * against markup the components actually render. That markup is written here, from the very
 * renders this suite pins, into `e2e/fixtures/hive-primitives/` when
 * `PRIMITIVES_FIXTURE_DUMP=1` is set:
 *
 *     PRIMITIVES_FIXTURE_DUMP=1 npx jest -c jest.config.ts tests/primitives-hive-redesign.test.tsx -t fixtures
 *
 * Without the variable the test still runs — it renders every surface and checks each is there
 * — so a change to a component that would leave the fixtures stale fails loudly here before it
 * fails quietly in the browser.
 */
describe('the browser fixtures', () => {
  const OUT = path.join(__dirname, '..', 'e2e', 'fixtures', 'hive-primitives');
  const dump = process.env.PRIMITIVES_FIXTURE_DUMP === '1';

  /** Write one fixture, or just assert it could be. */
  const write = (name: string, html: string) => {
    expect(html.length).toBeGreaterThan(0);
    if (!dump) return;
    fs.mkdirSync(OUT, { recursive: true });
    fs.writeFileSync(path.join(OUT, `${name}.html`), html);
  };

  /** The page column the shell would put this screen in. */
  const page = () => document.querySelector('.page') as HTMLElement;

  /** Whichever dialog Radix has portalled, if any. */
  const dialog = () => document.querySelector('[role="dialog"]') as HTMLElement;

  it('renders every surface the browser spec mounts (and writes the fixtures on request)', async () => {
    await renderScreen();
    await screen.findByTestId('primitives-kpis');
    write('registry', page().outerHTML);

    fireEvent.click(screen.getByTestId('primitives-tab-namespaces'));
    await screen.findByRole('table', { name: 'Namespaces' });
    write('namespaces', page().outerHTML);

    fireEvent.click(screen.getByTestId('primitives-tab-settings'));
    await screen.findByRole('heading', { name: 'Registry storage' });
    write('settings', page().outerHTML);
  });

  it('renders the resolver with edges to draw', async () => {
    global.fetch = jest.fn((url: string) =>
      Promise.resolve({
        ok: true,
        status: 200,
        text: async () => '',
        json: async () => (url === '/api/types/resolve' ? RESOLVED : PAYLOADS[url] ?? { success: true }),
      })
    ) as unknown as typeof fetch;
    render(<PrimitivesManagementClient />);
    await screen.findByRole('table', { name: 'Primitives' });

    fireEvent.click(screen.getByTestId('primitives-tab-resolver'));
    await screen.findByRole('table', { name: 'Reference resolution' });
    write('resolver', page().outerHTML);
  });

  it('renders the two dialogs', async () => {
    await renderScreen();

    fireEvent.click(screen.getByTestId('primitives-create'));
    await screen.findByRole('heading', { name: 'Create primitive' });
    write('editor', dialog().outerHTML);
    fireEvent.keyDown(document.activeElement ?? document.body, { key: 'Escape' });

    await waitFor(() => expect(document.querySelector('[role="dialog"]')).toBeNull());

    fireEvent.click(screen.getByTestId('primitives-import'));
    await screen.findByRole('heading', { name: 'Import primitives' });
    write('import', dialog().outerHTML);
  });
});
