/**
 * Render/interaction tests for the catalog item detail view (MFI-23.9, #4018; MFI-25.1, #4086).
 *
 * The detail view must show the things the ticket calls for — source material (viewable /
 * downloadable), provenance (tool versions + import job), a normalized summary (services/operations/
 * types/channels), and the format/protocol pills + quality/lint orbs — all read off the
 * `/api/catalog/{id}` payload, and must stay publish-free. These assertions pin that contract and
 * the graceful "not captured" degradation when the import has recorded nothing yet.
 *
 * MFI-25.1 wraps those panels in a five-tab shell (Overview / Source & Code / Provenance /
 * Lint & Score / Versions). The tab tests below pin that the panes switch without a route change,
 * that the header CTAs (primary Convert, "View code") are wired, and that keyboard/ARIA tab
 * semantics hold. The panels themselves stay mounted (inactive ones `hidden`), so the pre-existing
 * panel assertions above still hold regardless of which tab is active.
 */

import React from 'react';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import '@testing-library/jest-dom';

const mockPush = jest.fn();
let mockSearch = '';
jest.mock('next/navigation', () => ({
  useRouter: () => ({ push: mockPush }),
  useSearchParams: () => new URLSearchParams(mockSearch),
}));

// The Test Bench tab (IXH-5.3) reads the tenant id off the session for saved-payload scoping.
jest.mock('@lib/auth/session-client', () => ({
  useAuthSession: () => ({ data: { user: { current_tenant_id: 'tenant-1' } } }),
}));

// The Test Bench's Monaco payload editor is irrelevant here; stub it to a plain textarea.
jest.mock('@monaco-editor/react', () => ({
  __esModule: true,
  default: (props: { value?: string }) => <textarea readOnly value={props.value ?? ''} />,
}));

import { CatalogItemDetailClient } from '../src/app/ade/dashboard/catalog/[id]/CatalogItemDetailClient';

const RICH_ITEM = {
  id: '11111111-2222-3333-4444-555555555555',
  name: 'Acme gRPC API',
  slug: 'acme-grpc-api',
  description: 'Imported from a .proto file.',
  enabled: true,
  deleted_at: null,
  created_at: '2026-06-01T00:00:00.000Z',
  updated_at: '2026-06-20T12:00:00.000Z',
  creator_name: 'Dana Import',
  creator_email: 'dana@example.com',
  qualityScore: 82,
  qualityGrade: 'B',
  publishable: false,
  sourceFormat: 'protobuf',
  protocol: 'grpc',
  formatMetadata: {
    sourceLabel: 'acme.proto',
    inputKind: 'file',
    importJobId: 'job-abc-123',
    sourceContent: 'syntax = "proto3";',
  },
  toolVersions: { protoc: '25.1' },
  summary: { services: 2, operations: 7, types: 12, channels: 0 },
  source: { kind: 'file', label: 'acme.proto', uri: null, hasContent: true, downloadable: true },
};

// A parsed model (MFI-25.2/25.3): two GraphQL-shaped groups with tagged entities + field rows.
const PARSED_GROUPS = [
  {
    title: 'Operations',
    subtitle: 'root fields on Query / Mutation',
    entities: [
      {
        name: 'orders',
        tag: 'QUERY',
        meta: '→ [Order]',
        fields: [
          { name: 'status', type: 'OrderStatus', description: 'Lifecycle state', required: false },
          { name: 'id', type: 'ID', description: null, required: true },
        ],
      },
      { name: 'placeOrder', tag: 'MUTATION', meta: '→ PlaceOrderPayload', fields: [] },
    ],
  },
  {
    title: 'Types',
    subtitle: null,
    entities: [
      {
        name: 'Order',
        tag: 'OBJECT',
        meta: '6 fields',
        fields: [{ name: 'total', type: 'Float', description: 'Order total', required: true }],
      },
    ],
  },
];

const PARSED_ITEM = { ...RICH_ITEM, parsed: PARSED_GROUPS };

function mockFetchItem(item: unknown, ok = true) {
  global.fetch = jest.fn().mockResolvedValue({
    ok,
    json: async () => (ok ? { success: true, item } : { success: false, error: 'Catalog item not found.' }),
  }) as unknown as typeof fetch;
}

describe('CatalogItemDetailClient', () => {
  afterEach(() => {
    jest.restoreAllMocks();
    mockPush.mockReset();
    mockSearch = '';
  });

  it('renders the header with name, format/protocol/source pills', async () => {
    mockFetchItem(RICH_ITEM);
    render(<CatalogItemDetailClient itemId={RICH_ITEM.id} />);

    await waitFor(() => expect(screen.getByText('Acme gRPC API')).toBeInTheDocument());
    // The format + protocol pills appear in the header (and again in the provenance panel).
    expect(screen.getAllByTestId('format-pill')[0]).toHaveTextContent('Protobuf');
    expect(screen.getAllByTestId('protocol-pill')[0]).toHaveTextContent('grpc');
    expect(screen.getAllByTestId('source-badge').length).toBeGreaterThanOrEqual(1);
    // Fetched the detail proxy for this id.
    expect(global.fetch).toHaveBeenCalledWith(`/api/catalog/${encodeURIComponent(RICH_ITEM.id)}`);
  });

  it('shows the normalized summary counts', async () => {
    mockFetchItem(RICH_ITEM);
    render(<CatalogItemDetailClient itemId={RICH_ITEM.id} />);

    const summary = await screen.findByTestId('catalog-detail-summary');
    expect(summary).toHaveTextContent('Services');
    expect(summary).toHaveTextContent('2');
    expect(summary).toHaveTextContent('Operations');
    expect(summary).toHaveTextContent('7');
    expect(summary).toHaveTextContent('Types');
    expect(summary).toHaveTextContent('12');
  });

  it('offers a raw-source download when the source is downloadable', async () => {
    mockFetchItem(RICH_ITEM);
    render(<CatalogItemDetailClient itemId={RICH_ITEM.id} />);

    const dl = await screen.findByTestId('catalog-detail-download');
    expect(dl).toHaveAttribute('href', `/api/catalog/${encodeURIComponent(RICH_ITEM.id)}/source`);
    expect(dl).toHaveTextContent(/download raw source/i);
  });

  it('shows provenance: tool versions and the import-job reference', async () => {
    mockFetchItem(RICH_ITEM);
    render(<CatalogItemDetailClient itemId={RICH_ITEM.id} />);

    const provenance = await screen.findByTestId('catalog-detail-provenance');
    expect(provenance).toHaveTextContent('protoc');
    expect(provenance).toHaveTextContent('25.1');
    expect(provenance).toHaveTextContent('job-abc-123');
    expect(provenance).toHaveTextContent('Dana Import');
  });

  it('opens the server-backed lint report from the quality orb when there is no browser history', async () => {
    const LINT_REPORT = {
      success: true,
      projectId: RICH_ITEM.id,
      versionRecordId: 'rev-1',
      versionId: '1.0.0',
      score: 82,
      grade: 'B',
      findings: [
        {
          id: 'lint-1',
          path: 'components.schemas.Order',
          category: 'documentation',
          rule: 'documentation.schema-missing-description',
          severity: 'warning',
          message: 'Schema is missing a description.',
        },
      ],
      ruleHits: { 'documentation.schema-missing-description': 1 },
      severityCounts: { error: 0, warning: 1, info: 0 },
      reportFingerprint: 'fp',
      baseRevisionId: null,
      compatibilityOverall: null,
    };
    global.fetch = jest.fn((url: string) =>
      Promise.resolve({
        ok: true,
        json: async () =>
          url.endsWith('/lint') ? LINT_REPORT : { success: true, item: RICH_ITEM },
      }),
    ) as unknown as typeof fetch;

    render(<CatalogItemDetailClient itemId={RICH_ITEM.id} />);

    const orb = await screen.findByTestId('catalog-detail-quality-orb');
    expect(orb).toHaveTextContent('82');
    fireEvent.click(orb);

    await waitFor(() =>
      expect(screen.getByText('documentation.schema-missing-description')).toBeInTheDocument(),
    );
    expect(global.fetch).toHaveBeenCalledWith(
      `/api/catalog/${encodeURIComponent(RICH_ITEM.id)}/lint`,
      expect.anything(),
    );
  });

  it('opens the server-backed lint report from the lint orb (MFI-23.10)', async () => {
    const LINT_REPORT = {
      success: true,
      projectId: RICH_ITEM.id,
      versionRecordId: 'rev-1',
      versionId: '1.0.0',
      score: 72,
      grade: 'C',
      findings: [
        {
          id: 'lint-1',
          path: 'components.schemas.Payment',
          category: 'documentation',
          rule: 'documentation.schema-missing-description',
          severity: 'warning',
          message: 'Schema is missing a description.',
        },
      ],
      ruleHits: { 'documentation.schema-missing-description': 1 },
      severityCounts: { error: 0, warning: 1, info: 0 },
      reportFingerprint: 'fp',
      baseRevisionId: null,
      compatibilityOverall: null,
    };
    // Resolve the detail payload and the lint report by URL so the lazy lint fetch is honoured.
    global.fetch = jest.fn((url: string) =>
      Promise.resolve({
        ok: true,
        json: async () =>
          url.endsWith('/lint') ? LINT_REPORT : { success: true, item: RICH_ITEM },
      })
    ) as unknown as typeof fetch;

    render(<CatalogItemDetailClient itemId={RICH_ITEM.id} />);

    const orb = await screen.findByTestId('catalog-detail-lint-orb');
    fireEvent.click(orb);

    await waitFor(() =>
      expect(screen.getByText('documentation.schema-missing-description')).toBeInTheDocument()
    );
    expect(global.fetch).toHaveBeenCalledWith(
      `/api/catalog/${encodeURIComponent(RICH_ITEM.id)}/lint`,
      expect.objectContaining({ method: 'GET' })
    );
    expect(screen.getByText('Schema is missing a description.')).toBeInTheDocument();
  });

  it('degrades gracefully when nothing was captured at import', async () => {
    mockFetchItem({
      ...RICH_ITEM,
      formatMetadata: null,
      toolVersions: null,
      summary: { services: null, operations: null, types: null, channels: null },
      source: { kind: null, label: null, uri: null, hasContent: false, downloadable: false },
    });
    render(<CatalogItemDetailClient itemId={RICH_ITEM.id} />);

    await waitFor(() => expect(screen.getByText('Acme gRPC API')).toBeInTheDocument());
    expect(screen.getByTestId('catalog-detail-no-source')).toBeInTheDocument();
    expect(screen.getByTestId('catalog-detail-summary')).toHaveTextContent(/not been captured/i);
    expect(screen.queryByTestId('catalog-detail-download')).not.toBeInTheDocument();
  });

  it('renders an error state when the item is not found', async () => {
    mockFetchItem(null, false);
    render(<CatalogItemDetailClient itemId="missing" />);

    await waitFor(() =>
      expect(screen.getByTestId('catalog-detail-error')).toHaveTextContent(/not found/i),
    );
  });

  it('never renders a Publish affordance (non-publishable invariant, MFI-23.1)', async () => {
    mockFetchItem(RICH_ITEM);
    render(<CatalogItemDetailClient itemId={RICH_ITEM.id} />);

    await waitFor(() => expect(screen.getByText('Acme gRPC API')).toBeInTheDocument());
    expect(screen.queryByText(/publish/i)).not.toBeInTheDocument();
  });

  it('offers a "Convert to OpenAPI Project" action for an unconverted non-OpenAPI item (MFI-23.11)', async () => {
    mockFetchItem(RICH_ITEM);
    render(<CatalogItemDetailClient itemId={RICH_ITEM.id} />);

    const convert = await screen.findByTestId('catalog-detail-convert');
    expect(convert).toHaveTextContent('Convert to OpenAPI Project');
    // No converted-state panel until the item has actually been converted.
    expect(screen.queryByTestId('catalog-detail-converted')).not.toBeInTheDocument();
  });

  it('offers "Convert to Project" for an unconverted OpenAPI or Arazzo item', async () => {
    mockFetchItem({ ...RICH_ITEM, sourceFormat: 'openapi-3.1', name: 'Acme OpenAPI' });
    render(<CatalogItemDetailClient itemId={RICH_ITEM.id} />);

    expect(await screen.findByTestId('catalog-detail-convert')).toHaveTextContent('Convert to Project');
  });

  it('shows the Converted → {project} back-link and a Re-convert action once converted (MFI-23.11)', async () => {
    mockFetchItem({
      ...RICH_ITEM,
      conversion: {
        projectId: 'proj-openapi',
        projectName: 'Acme OpenAPI',
        projectSlug: 'acme-openapi',
        projectDeleted: false,
        versionId: '1.0.1',
        versionRecordId: 'ver-1',
        reconverted: true,
        convertedAt: '2026-06-25T00:00:00.000Z',
        fidelityGrade: 'B',
        fidelityTier: 'medium',
      },
    });
    render(<CatalogItemDetailClient itemId={RICH_ITEM.id} />);

    const converted = await screen.findByTestId('catalog-detail-converted');
    expect(converted).toHaveTextContent(/Re-converted to OpenAPI project/i);
    const link = screen.getByRole('link', { name: 'Acme OpenAPI' });
    expect(link).toHaveAttribute('href', '/ade/dashboard/versions?projectId=proj-openapi');
    // The convert action relabels to Re-convert (re-convert is always allowed).
    expect(screen.getByTestId('catalog-detail-convert')).toHaveTextContent('Re-convert to OpenAPI Project');
  });

  it('jumps from the converted banner into the Conversions tab (CPDO-3.3)', async () => {
    mockFetchItem({
      ...RICH_ITEM,
      conversion: {
        projectId: 'proj-openapi',
        projectName: 'Acme OpenAPI',
        projectSlug: 'acme-openapi',
        projectDeleted: false,
        versionId: '1.0.1',
        versionRecordId: 'ver-1',
        reconverted: false,
        convertedAt: '2026-06-25T00:00:00.000Z',
        fidelityGrade: 'B',
        fidelityTier: 'medium',
        provenanceId: 'prov-1',
        manifestHash: 'a'.repeat(64),
      },
    });
    render(<CatalogItemDetailClient itemId={RICH_ITEM.id} />);

    fireEvent.click(await screen.findByTestId('catalog-detail-converted-history-link'));

    expect(screen.getByTestId('catalog-detail-tab-conversions')).toHaveAttribute(
      'aria-selected',
      'true',
    );
    expect(screen.getByTestId('catalog-detail-pane-conversions')).toBeVisible();
    // The history panel mounted inside the pane (its own behaviour is covered in
    // CatalogConversionHistoryPanel.test.tsx).
    await waitFor(() =>
      expect(screen.getByTestId('conversion-history-panel')).toBeInTheDocument(),
    );
    expect(mockPush).not.toHaveBeenCalled();
  });

  it('opens the Conversions tab from a ?tab=conversions deep link (CPDO-3.3)', async () => {
    mockSearch = 'tab=conversions';
    mockFetchItem(RICH_ITEM);
    render(<CatalogItemDetailClient itemId={RICH_ITEM.id} />);

    await screen.findByTestId('catalog-detail-tabs');
    expect(screen.getByTestId('catalog-detail-tab-conversions')).toHaveAttribute(
      'aria-selected',
      'true',
    );
    expect(screen.getByTestId('catalog-detail-pane-conversions')).toBeVisible();
  });

  // ── Tabbed detail shell (MFI-25.1, #4086) ──────────────────────────────────────────────────

  it('renders the five-tab shell with Overview active by default', async () => {
    mockFetchItem(RICH_ITEM);
    render(<CatalogItemDetailClient itemId={RICH_ITEM.id} />);

    await screen.findByTestId('catalog-detail-tabs');
    for (const [id, label] of [
      ['overview', 'Overview'],
      // Format details (CPDO-2.1, #4797) — the native payload view, beside the canonical Overview.
      ['format', 'Format details'],
      ['source', 'Source & Code'],
      ['provenance', 'Provenance'],
      // Conversions (CPDO-3.3, #4803) — the provenance evidence history.
      ['conversions', 'Conversions'],
      ['lint', 'Lint & Score'],
      ['versions', 'Versions'],
    ] as const) {
      expect(screen.getByTestId(`catalog-detail-tab-${id}`)).toHaveTextContent(label);
    }
    // Overview is selected and its pane is the only visible one.
    expect(screen.getByTestId('catalog-detail-tab-overview')).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByTestId('catalog-detail-pane-overview')).toBeVisible();
    expect(screen.getByTestId('catalog-detail-pane-provenance')).not.toBeVisible();
  });

  it('switches panes without a route change when a tab is selected', async () => {
    mockFetchItem(RICH_ITEM);
    render(<CatalogItemDetailClient itemId={RICH_ITEM.id} />);

    const provenanceTab = await screen.findByTestId('catalog-detail-tab-provenance');
    fireEvent.click(provenanceTab);

    expect(provenanceTab).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByTestId('catalog-detail-tab-overview')).toHaveAttribute('aria-selected', 'false');
    expect(screen.getByTestId('catalog-detail-pane-provenance')).toBeVisible();
    expect(screen.getByTestId('catalog-detail-pane-overview')).not.toBeVisible();
    // Tabs never navigate — the router is untouched.
    expect(mockPush).not.toHaveBeenCalled();
  });

  it('activates the Source tab from the header "View code" button', async () => {
    mockFetchItem(RICH_ITEM);
    render(<CatalogItemDetailClient itemId={RICH_ITEM.id} />);

    const viewCode = await screen.findByTestId('catalog-detail-view-code');
    fireEvent.click(viewCode);

    expect(screen.getByTestId('catalog-detail-tab-source')).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByTestId('catalog-detail-pane-source')).toBeVisible();
    expect(mockPush).not.toHaveBeenCalled();
  });

  it('opens the ConversionPreviewDialog from the primary Convert CTA', async () => {
    mockFetchItem(RICH_ITEM);
    render(<CatalogItemDetailClient itemId={RICH_ITEM.id} />);

    const convert = await screen.findByTestId('catalog-detail-convert');
    // No dialog is mounted until the CTA fires.
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    fireEvent.click(convert);
    await waitFor(() => expect(screen.getByRole('dialog')).toBeInTheDocument());
  });

  it('opens the Export Studio from the Export CTA without touching Convert (MFX-41.2, #4349)', async () => {
    mockFetchItem(RICH_ITEM);
    render(<CatalogItemDetailClient itemId={RICH_ITEM.id} />);

    const exportCta = await screen.findByTestId('catalog-detail-export');
    // The CTA states the Export-vs-Convert distinction (export never mints a Project).
    expect(exportCta).toHaveAttribute('title', expect.stringContaining('never turns the item into a project'));
    // No conversion preview is opened by exporting.
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    fireEvent.click(exportCta);

    // Export routes to the version-scoped Export Studio (the power path), carrying the catalog
    // origin (back-link → Catalog) and the source format (hide the same-format target).
    expect(mockPush).toHaveBeenCalledTimes(1);
    const href = mockPush.mock.calls[0][0] as string;
    expect(href).toContain('/ade/dashboard/export/studio');
    const params = new URLSearchParams(href.split('?')[1]);
    expect(params.get('artifact')).toBe(RICH_ITEM.id);
    expect(params.get('label')).toBe(RICH_ITEM.name);
    expect(params.get('from')).toBe('catalog');
    expect(params.get('sourceFormat')).toBe('protobuf');
    // Convert stays present and unchanged next to it — no conversion dialog opened.
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(screen.getByTestId('catalog-detail-convert')).toHaveTextContent('Convert to OpenAPI Project');
  });

  it('exposes ARIA tab semantics and moves selection + focus with the arrow keys', async () => {
    mockFetchItem(RICH_ITEM);
    render(<CatalogItemDetailClient itemId={RICH_ITEM.id} />);

    const tablist = await screen.findByTestId('catalog-detail-tabs');
    expect(tablist).toHaveAttribute('role', 'tablist');
    const overviewTab = screen.getByTestId('catalog-detail-tab-overview');
    const sourceTab = screen.getByTestId('catalog-detail-tab-source');
    // Roving tabindex: only the active tab is in the tab order, and it controls its pane.
    expect(overviewTab).toHaveAttribute('tabindex', '0');
    expect(sourceTab).toHaveAttribute('tabindex', '-1');
    expect(overviewTab).toHaveAttribute('aria-controls', 'catalog-detail-panel-overview');
    expect(screen.getByTestId('catalog-detail-pane-overview')).toHaveAttribute(
      'id',
      'catalog-detail-panel-overview',
    );

    overviewTab.focus();
    // Format details (CPDO-2.1, #4797) sits between Overview and Source & Code, so one ArrowRight
    // reaches it and the second reaches Source & Code.
    fireEvent.keyDown(overviewTab, { key: 'ArrowRight' });

    const formatTab = screen.getByTestId('catalog-detail-tab-format');
    expect(formatTab).toHaveAttribute('aria-selected', 'true');
    expect(formatTab).toHaveAttribute('tabindex', '0');
    expect(document.activeElement).toBe(formatTab);

    fireEvent.keyDown(formatTab, { key: 'ArrowRight' });

    expect(sourceTab).toHaveAttribute('aria-selected', 'true');
    expect(sourceTab).toHaveAttribute('tabindex', '0');
    expect(document.activeElement).toBe(sourceTab);
  });

  it('renders the converted project as plain text (no link) when the target was deleted', async () => {
    mockFetchItem({
      ...RICH_ITEM,
      conversion: {
        projectId: 'proj-openapi',
        projectName: null,
        projectSlug: null,
        projectDeleted: true,
        versionId: '1.0.0',
        reconverted: false,
      },
    });
    render(<CatalogItemDetailClient itemId={RICH_ITEM.id} />);

    const converted = await screen.findByTestId('catalog-detail-converted');
    expect(converted).toHaveTextContent(/Converted to OpenAPI project/i);
    // A deleted target has no live link.
    expect(screen.queryByRole('link', { name: /project proj-ope/i })).not.toBeInTheDocument();
  });

  // ── Parsed-entity rendering in Overview (MFI-25.3, #4088) ────────────────────────────────────

  it('renders parsed entity groups with tags, names, meta, and field rows', async () => {
    mockFetchItem(PARSED_ITEM);
    render(<CatalogItemDetailClient itemId={PARSED_ITEM.id} />);

    const overview = await screen.findByTestId('catalog-detail-pane-overview');
    // Group headings + subtitle.
    expect(overview).toHaveTextContent('Operations');
    expect(overview).toHaveTextContent('root fields on Query / Mutation');
    expect(overview).toHaveTextContent('Types');
    // Entity headers: colored tag + name + meta.
    const tags = screen.getAllByTestId('catalog-detail-parsed-tag').map((t) => t.textContent);
    expect(tags).toEqual(expect.arrayContaining(['QUERY', 'MUTATION', 'OBJECT']));
    expect(overview).toHaveTextContent('orders');
    expect(overview).toHaveTextContent('→ [Order]');
    expect(overview).toHaveTextContent('placeOrder');
    expect(overview).toHaveTextContent('Order');
    // Field rows: name / type / description.
    expect(overview).toHaveTextContent('status');
    expect(overview).toHaveTextContent('OrderStatus');
    expect(overview).toHaveTextContent('Lifecycle state');
    expect(overview).toHaveTextContent('total');
    expect(overview).toHaveTextContent('Float');
    // Two groups rendered as cards.
    expect(screen.getAllByTestId('catalog-detail-parsed-group')).toHaveLength(2);
    // Empty groups never render fields for a fieldless entity like placeOrder (no crash).
    expect(screen.getAllByTestId('catalog-detail-parsed-entity')).toHaveLength(3);
  });

  it('deep-links a lint finding to its highlighted Overview entity (MFI-28.2)', async () => {
    // jsdom has no scrollIntoView — stub it so the deep-link effect can run.
    const scrollSpy = jest.fn();
    Element.prototype.scrollIntoView = scrollSpy;

    const LINT_REPORT = {
      success: true,
      projectId: PARSED_ITEM.id,
      versionRecordId: 'rev-1',
      versionId: '1.0.0',
      score: 80,
      grade: 'B',
      findings: [
        {
          id: 'lint-order',
          path: 'components.schemas.Order',
          category: 'documentation',
          rule: 'documentation.schema-missing-description',
          severity: 'error',
          message: 'Order is missing a description.',
        },
      ],
      ruleHits: { 'documentation.schema-missing-description': 1 },
      severityCounts: { error: 1, warning: 0, info: 0 },
      reportFingerprint: 'fp',
      baseRevisionId: null,
      compatibilityOverall: null,
    };
    global.fetch = jest.fn((url: string) =>
      Promise.resolve({
        ok: true,
        json: async () =>
          url.endsWith('/lint') ? LINT_REPORT : { success: true, item: PARSED_ITEM },
      })
    ) as unknown as typeof fetch;

    render(<CatalogItemDetailClient itemId={PARSED_ITEM.id} />);

    // Activate the Lint & Score tab so the panel lazily fetches its report.
    fireEvent.click(await screen.findByTestId('catalog-detail-tab-lint'));
    const link = await screen.findByTestId('catalog-lint-finding-link');
    expect(link).toHaveTextContent('components.schemas.Order');

    // Following the finding switches back to Overview, scrolls to and highlights the Order entity.
    fireEvent.click(link);
    await waitFor(() =>
      expect(screen.getByTestId('catalog-detail-tab-overview')).toHaveAttribute(
        'aria-selected',
        'true',
      ),
    );
    expect(scrollSpy).toHaveBeenCalled();
    const order = document.getElementById('catalog-entity-Order');
    expect(order).not.toBeNull();
    expect(order!.className).toContain('ring-2'); // transient deep-link highlight
  });

  it('colors each entity tag per its kind (QUERY blue, MUTATION amber, OBJECT emerald)', async () => {
    mockFetchItem(PARSED_ITEM);
    render(<CatalogItemDetailClient itemId={PARSED_ITEM.id} />);

    await screen.findByTestId('catalog-detail-pane-overview');
    const byTag = new Map(
      screen.getAllByTestId('catalog-detail-parsed-tag').map((el) => [el.textContent, el.className]),
    );
    expect(byTag.get('QUERY')).toContain('bg-blue-100');
    expect(byTag.get('MUTATION')).toContain('bg-amber-100');
    expect(byTag.get('OBJECT')).toContain('bg-emerald-100');
  });

  it('derives the summaryNote sub-line from the parsed groups under the count boxes', async () => {
    mockFetchItem(PARSED_ITEM);
    render(<CatalogItemDetailClient itemId={PARSED_ITEM.id} />);

    const note = await screen.findByTestId('catalog-detail-summary-note');
    // Tag tallies per group, in first-seen order, pluralized.
    expect(note).toHaveTextContent('1 query · 1 mutation · 1 object');
    // The note lives inside the normalized-summary section, beside the count boxes.
    expect(screen.getByTestId('catalog-detail-summary')).toContainElement(note);
  });

  it('marks required fields and leaves optional ones unmarked', async () => {
    mockFetchItem(PARSED_ITEM);
    render(<CatalogItemDetailClient itemId={PARSED_ITEM.id} />);

    await screen.findByTestId('catalog-detail-pane-overview');
    // The `id` field is required → its type cell carries a `*` marker.
    const idType = screen.getByText('ID').closest('[data-testid="catalog-detail-parsed-field"]');
    expect(idType).toHaveTextContent(/\*/);
    // The optional `status` field is not marked.
    const statusType = screen
      .getByText('OrderStatus')
      .closest('[data-testid="catalog-detail-parsed-field"]');
    expect(statusType).not.toHaveTextContent(/\*/);
  });

  // ── Overview observability + provenance pipeline enrichments ────────────────────────────────

  it('renders the API-surface tiles with their share of the captured counts and a composition bar', async () => {
    mockFetchItem(RICH_ITEM);
    render(<CatalogItemDetailClient itemId={RICH_ITEM.id} />);

    const summary = await screen.findByTestId('catalog-detail-summary');
    // 2 + 7 + 12 + 0 = 21 normalized entities, with per-kind shares on the tiles.
    expect(summary).toHaveTextContent('21 normalized entities');
    const tiles = screen.getAllByTestId('catalog-detail-surface-tile');
    expect(tiles).toHaveLength(4);
    expect(tiles[0]).toHaveTextContent('Services');
    expect(tiles[0]).toHaveTextContent('10% of surface');
    expect(tiles[1]).toHaveTextContent('33% of surface');
    expect(tiles[2]).toHaveTextContent('57% of surface');
    // Channels is captured but zero, so its share is 0%.
    expect(tiles[3]).toHaveTextContent('0% of surface');
    // The stacked composition bar renders one segment per non-zero count.
    expect(screen.getByTestId('catalog-detail-surface-bar').querySelectorAll('[title]')).toHaveLength(3);
  });

  it('derives model observability (documentation coverage + entity-kind mix) from the parsed model', async () => {
    mockFetchItem(PARSED_ITEM);
    render(<CatalogItemDetailClient itemId={PARSED_ITEM.id} />);

    const insights = await screen.findByTestId('catalog-detail-insights');
    expect(insights).toHaveTextContent('3 entities');
    expect(insights).toHaveTextContent('3 fields');
    // 2 of 3 fields carry a description ('Lifecycle state', 'Order total') → 67%.
    const docs = screen.getByTestId('catalog-detail-docs-coverage');
    expect(docs).toHaveTextContent('2');
    expect(docs).toHaveTextContent('67% carry a description');
    // 2 of 3 fields are required (id, total) → 67%.
    expect(screen.getByTestId('catalog-detail-required-coverage')).toHaveTextContent('67% are required');
    // The kind mix chips tally the tags with their share.
    const mix = screen.getByTestId('catalog-detail-kind-mix');
    expect(mix).toHaveTextContent('QUERY');
    expect(mix).toHaveTextContent('MUTATION');
    expect(mix).toHaveTextContent('OBJECT');
    expect(mix).toHaveTextContent('1 · 33%');
  });

  it('omits the model-observability panel when there is no parsed model', async () => {
    mockFetchItem(RICH_ITEM);
    render(<CatalogItemDetailClient itemId={RICH_ITEM.id} />);

    await screen.findByTestId('catalog-detail-pane-overview');
    expect(screen.queryByTestId('catalog-detail-insights')).not.toBeInTheDocument();
  });

  it('shows the quality snapshot with the captured score and jumps to the Lint tab', async () => {
    mockFetchItem(RICH_ITEM);
    render(<CatalogItemDetailClient itemId={RICH_ITEM.id} />);

    const snapshot = await screen.findByTestId('catalog-detail-quality-snapshot');
    expect(snapshot).toHaveTextContent('82');
    expect(snapshot).toHaveTextContent('/100');
    // The grade chip carries the captured letter grade.
    expect(snapshot.querySelector('[data-testid="grade-chip"]')).toHaveTextContent('B');

    fireEvent.click(screen.getByTestId('catalog-detail-open-lint'));
    expect(screen.getByTestId('catalog-detail-tab-lint')).toHaveAttribute('aria-selected', 'true');
    expect(mockPush).not.toHaveBeenCalled();
  });

  it('shows the source snapshot with intake facts and jumps to the Source tab', async () => {
    mockFetchItem(RICH_ITEM);
    render(<CatalogItemDetailClient itemId={RICH_ITEM.id} />);

    const snapshot = await screen.findByTestId('catalog-detail-source-snapshot');
    expect(snapshot).toHaveTextContent('acme.proto');
    expect(snapshot).toHaveTextContent('File upload');
    expect(snapshot).toHaveTextContent('Content captured');
    expect(snapshot).toHaveTextContent('Downloadable');

    fireEvent.click(screen.getByTestId('catalog-detail-open-source'));
    expect(screen.getByTestId('catalog-detail-tab-source')).toHaveAttribute('aria-selected', 'true');
    expect(mockPush).not.toHaveBeenCalled();
  });

  it('renders provenance as a four-stage pipeline carrying the import facts', async () => {
    mockFetchItem(RICH_ITEM);
    render(<CatalogItemDetailClient itemId={RICH_ITEM.id} />);

    const provenance = await screen.findByTestId('catalog-detail-provenance');
    // The four stages, in journey order.
    expect(screen.getByTestId('catalog-detail-stage-intake')).toHaveTextContent('acme.proto');
    expect(screen.getByTestId('catalog-detail-stage-intake')).toHaveTextContent('Content captured');
    expect(screen.getByTestId('catalog-detail-stage-detection')).toHaveTextContent('Protobuf');
    expect(screen.getByTestId('catalog-detail-stage-normalization')).toHaveTextContent('protoc');
    expect(screen.getByTestId('catalog-detail-stage-normalization')).toHaveTextContent('25.1');
    const record = screen.getByTestId('catalog-detail-stage-record');
    expect(record).toHaveTextContent('job-abc-123');
    expect(record).toHaveTextContent('Dana Import');
    // Timestamps carry a coarse relative phrase alongside the absolute instant.
    expect(record).toHaveTextContent(/ago/);
    // Everything stays inside the provenance panel.
    expect(provenance).toContainElement(record);
  });

  it('degrades each pipeline stage gracefully when nothing was recorded', async () => {
    mockFetchItem({
      ...RICH_ITEM,
      sourceFormat: null,
      protocol: null,
      formatMetadata: null,
      toolVersions: null,
      source: { kind: null, label: null, uri: null, hasContent: false, downloadable: false },
    });
    render(<CatalogItemDetailClient itemId={RICH_ITEM.id} />);

    await screen.findByTestId('catalog-detail-provenance');
    expect(screen.getByTestId('catalog-detail-stage-intake')).toHaveTextContent('Not recorded');
    expect(screen.getByTestId('catalog-detail-stage-detection')).toHaveTextContent(
      /no detected format/i,
    );
    expect(screen.getByTestId('catalog-detail-stage-normalization')).toHaveTextContent(
      /not recorded/i,
    );
    expect(screen.getByTestId('catalog-detail-stage-record')).toHaveTextContent('Not recorded');
  });

  it('shows a graceful "no parsed model" note when the model is absent', async () => {
    // RICH_ITEM has no `parsed` field, so the model degrades to empty.
    mockFetchItem(RICH_ITEM);
    render(<CatalogItemDetailClient itemId={RICH_ITEM.id} />);

    await screen.findByTestId('catalog-detail-pane-overview');
    expect(screen.getByTestId('catalog-detail-parsed-empty')).toHaveTextContent(
      /no parsed model is available/i,
    );
    // Count boxes still render; no summaryNote and no parsed groups.
    expect(screen.getByTestId('catalog-detail-summary')).toHaveTextContent('Services');
    expect(screen.queryByTestId('catalog-detail-summary-note')).not.toBeInTheDocument();
    expect(screen.queryByTestId('catalog-detail-parsed-group')).not.toBeInTheDocument();
  });
});
