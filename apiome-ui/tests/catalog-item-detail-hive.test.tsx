/**
 * The redesigned Catalog item detail, rendered (HIVE-7.2, #5319).
 *
 * `tests/catalog-item-view.test.ts` pins the decisions this screen makes and
 * `tests/catalog-item-detail-css.test.ts` pins the declarations that paint them. This suite is
 * the third leg: it mounts the real screen against a mocked read and pins the things only a
 * render can answer — that the page chrome is `Page`/`PageHeader`/`PageBody`, that the eight
 * panes exist with their ARIA wiring, that the deleted state actually removes the two writing
 * verbs, that the converted strip strikes a dead target through, and that the tab counts
 * appear only once the panes that own them have loaded.
 *
 * It also writes the browser fixtures `e2e/hive-catalog-item.spec.ts` measures, so what is
 * measured there is exactly what these components compose.
 */

import * as fs from 'fs';
import * as path from 'path';
import React from 'react';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import '@testing-library/jest-dom';

const mockPush = jest.fn();
let mockSearch = '';
jest.mock('next/navigation', () => ({
  useRouter: () => ({ push: mockPush }),
  useSearchParams: () => new URLSearchParams(mockSearch),
}));

jest.mock('@lib/auth/session-client', () => ({
  useAuthSession: () => ({ data: { user: { current_tenant_id: 'tenant-1' } } }),
}));

// The Test bench's Monaco payload editor is irrelevant here; stub it to a plain textarea.
jest.mock('@monaco-editor/react', () => ({
  __esModule: true,
  default: (props: { value?: string }) => <textarea readOnly value={props.value ?? ''} />,
}));

import { CatalogItemDetailClient } from '../src/app/ade/dashboard/catalog/[id]/CatalogItemDetailClient';
import { CatalogFormatDetailPanel } from '@/app/components/ade/dashboard/catalog/CatalogFormatDetailPanel';
import { resetFormatCapabilitiesCache } from '@/app/components/ade/dashboard/catalog/useFormatCapabilities';
import type { AnalysisRecord } from '@/app/utils/catalog-payload-analysis';
import {
  AVAILABLE_SUMMARY,
  copybookLayoutRecord,
  REGISTRY_SNAPSHOT,
  x12ScannedRecord,
} from './helpers/payload-analysis-fixture';

/** The mockup's item: an X12 interchange, scored B, already converted once. */
const ITEM = {
  id: 'c3a5e1f0-0000-4000-8000-000000000001',
  name: 'Claims 837P',
  slug: 'claims-837p',
  description:
    'Professional healthcare claim interchange from the Contoso Health clearinghouse (005010X222A1).',
  enabled: true,
  deleted_at: null,
  created_at: '2026-08-12T14:40:00.000Z',
  updated_at: '2026-08-15T09:41:00.000Z',
  creator_name: 'Ada Lovelace',
  creator_email: 'ada@example.com',
  qualityScore: 84,
  qualityGrade: 'B',
  publishable: false,
  sourceFormat: 'x12',
  protocol: 'data-schema',
  formatMetadata: {
    sourceLabel: 'claims-837p-sample.edi',
    inputKind: 'file',
    importJobId: 'job_2c9f4a71',
  },
  toolVersions: { 'x12-adapter': '1.4.0', pyx12: '3.1.0' },
  summary: { services: 1, operations: 1, types: 27, channels: null },
  source: {
    kind: 'file',
    label: 'claims-837p-sample.edi',
    uri: 'upload://claims-837p-sample.edi',
    hasContent: true,
    downloadable: true,
  },
  conversion: {
    projectId: 'proj_5c0d21',
    projectName: 'Claims 837P (OpenAPI)',
    versionId: 'ver_5c0d21',
    reconverted: true,
  },
  parsed: [
    {
      title: 'Types',
      subtitle: 'Loops and segments of the 837P transaction set',
      entities: [
        {
          name: 'Loop2300_Claim',
          tag: 'OBJECT',
          meta: 'CLM · HI · DTP',
          fields: [
            {
              name: 'patientControlNumber',
              type: 'string',
              description: "CLM01 — provider's claim id",
              required: true,
            },
            {
              name: 'totalChargeAmount',
              type: 'decimal',
              description: 'CLM02 — sum of service-line charges',
              required: true,
            },
            { name: 'placeOfService', type: 'CLM05 composite', description: null, required: false },
          ],
        },
        { name: 'ClaimFrequencyCode', tag: 'ENUM', meta: 'CLM05-3', fields: [] },
      ],
    },
  ],
  relatedArtifacts: [],
};

/** Route every read this screen makes; only `/api/catalog/{id}` returns anything. */
function mockReads(item: unknown, ok = true) {
  global.fetch = jest.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url === `/api/catalog/${encodeURIComponent(ITEM.id)}`) {
      return {
        ok,
        json: async () =>
          ok ? { success: true, item } : { success: false, error: 'Catalog item not found.' },
      } as Response;
    }
    if (url.includes('/lint')) {
      return {
        ok: true,
        json: async () => ({
          success: true,
          versionId: 'ver_5c0d21',
          score: 84,
          grade: 'B',
          findings: [],
          categories: null,
        }),
      } as Response;
    }
    return { ok: true, json: async () => ({ success: true }) } as Response;
  }) as unknown as typeof fetch;
}

/** Render the screen and wait for its heading. */
async function renderDetail(item: unknown = ITEM) {
  mockReads(item);
  const view = render(<CatalogItemDetailClient itemId={ITEM.id} />);
  await waitFor(() =>
    expect(screen.getByRole('heading', { level: 1, name: /Claims 837P/ })).toBeInTheDocument(),
  );
  return view;
}

afterEach(() => {
  jest.restoreAllMocks();
  mockPush.mockReset();
  mockSearch = '';
});

describe('the page chrome', () => {
  it('is Page / PageHeader / PageBody, with the shell breadcrumb above the title', async () => {
    await renderDetail();
    expect(document.querySelector('.page')).not.toBeNull();
    expect(document.querySelector('.page-header')).not.toBeNull();
    expect(document.querySelector('.page-body')).not.toBeNull();

    const crumbs = screen.getByTestId('page-breadcrumb');
    expect(crumbs).toHaveTextContent('Home');
    expect(crumbs).toHaveTextContent('Bring in');
    expect(crumbs).toHaveTextContent('Catalog');
  });

  it('carries the hex avatar, the status badge and the identity line', async () => {
    await renderDetail();
    // `.avatar-hex` is the honeycomb silhouette DESIGN.md §2 gives an identity mark.
    expect(document.querySelector('.page-header .avatar-hex')).not.toBeNull();
    expect(screen.getByTestId('catalog-detail-status')).toHaveTextContent('Active');
    expect(screen.getByText(/cat_c3a5e · claims-837p/)).toBeInTheDocument();
  });

  it('draws the format, protocol and source pills in the header meta row', async () => {
    await renderDetail();
    const meta = document.querySelector('.cid-meta')!;
    expect(within(meta as HTMLElement).getByTestId('format-pill')).toHaveTextContent(/X12/i);
    expect(within(meta as HTMLElement).getByTestId('protocol-pill')).toBeInTheDocument();
    expect(within(meta as HTMLElement).getByTestId('source-badge')).toBeInTheDocument();
  });

  it('gives the header exactly one primary action — Convert', async () => {
    await renderDetail();
    // DESIGN.md §7: one ink-filled button per screen. Export and View code are outlines.
    const convert = screen.getByTestId('catalog-detail-convert');
    expect(convert).toHaveTextContent('Re-convert to OpenAPI Project');
    expect(screen.getByTestId('catalog-detail-export')).toBeInTheDocument();
    expect(screen.getByTestId('catalog-detail-view-code')).toBeInTheDocument();
  });

  it('draws both orbs, and opens the report each one names', async () => {
    await renderDetail();
    // A server-scored item sends the Quality orb to the itemized server report.
    fireEvent.click(screen.getByTestId('catalog-detail-quality-orb'));
    expect(await screen.findByText(/Quality & Lint report/i)).toBeInTheDocument();
  });
});

describe('the eight panes', () => {
  it('wires every tab to its panel and starts on Overview', async () => {
    await renderDetail();
    const tabs = screen.getAllByRole('tab');
    expect(tabs).toHaveLength(8);
    for (const tab of tabs) {
      const panel = document.getElementById(tab.getAttribute('aria-controls')!);
      expect(panel).not.toBeNull();
      expect(panel!.getAttribute('aria-labelledby')).toBe(tab.id);
    }
    expect(screen.getByTestId('catalog-detail-tab-overview')).toHaveAttribute(
      'aria-selected',
      'true',
    );
    expect(screen.getByTestId('catalog-detail-pane-overview')).toBeVisible();
    expect(screen.getByTestId('catalog-detail-pane-versions')).not.toBeVisible();
  });

  it('moves selection and focus with the arrow keys, wrapping at the ends', async () => {
    await renderDetail();
    const first = screen.getByTestId('catalog-detail-tab-overview');
    first.focus();
    fireEvent.keyDown(first, { key: 'ArrowLeft' });
    // Wraps to the last tab.
    expect(screen.getByTestId('catalog-detail-tab-versions')).toHaveAttribute(
      'aria-selected',
      'true',
    );
    fireEvent.keyDown(screen.getByTestId('catalog-detail-tab-versions'), { key: 'Home' });
    expect(first).toHaveAttribute('aria-selected', 'true');
  });

  it('opens the pane a ?tab= deep link names', async () => {
    mockSearch = 'tab=provenance';
    await renderDetail();
    expect(screen.getByTestId('catalog-detail-pane-provenance')).toBeVisible();
  });

  it('lets a compatibility source link beat the ?tab= beside it', async () => {
    mockSearch = 'tab=lint&sourcePath=claims.edi&line=16';
    await renderDetail();
    expect(screen.getByTestId('catalog-detail-pane-source')).toBeVisible();
  });

  it('draws no count chip on a pane whose data has not loaded', async () => {
    await renderDetail();
    // Nothing has been opened, so Conversions / Lint & score / Versions carry no chip.
    for (const id of ['conversions', 'lint', 'versions']) {
      expect(screen.getByTestId(`catalog-detail-tab-${id}`).querySelector('.tab-count')).toBeNull();
    }
  });
});

describe('the Overview pane', () => {
  it('draws the four surface tiles and the composition bar they share a colour with', async () => {
    await renderDetail();
    const tiles = screen.getAllByTestId('catalog-detail-surface-tile');
    expect(tiles).toHaveLength(4);
    // Channels was never captured — an em dash and "Not captured", not a zero.
    expect(tiles[3]).toHaveTextContent('Not captured');
    expect(tiles[2]).toHaveTextContent('27');

    const bar = screen.getByTestId('catalog-detail-surface-bar');
    expect(bar.querySelectorAll('.cid-compbar__slice')).toHaveLength(3);
  });

  it('says so plainly when nothing was captured', async () => {
    await renderDetail({
      ...ITEM,
      summary: { services: null, operations: null, types: null, channels: null },
    });
    expect(screen.getByTestId('catalog-detail-summary')).toHaveTextContent(/not been captured/i);
    expect(screen.queryByTestId('catalog-detail-surface-bar')).not.toBeInTheDocument();
  });

  it('prints the quality band in the grade vocabulary beside the captured letter', async () => {
    await renderDetail();
    const snapshot = screen.getByTestId('catalog-detail-quality-snapshot');
    expect(snapshot).toHaveTextContent('84');
    expect(snapshot).toHaveTextContent('Good · 70–89');
    expect(snapshot).toHaveTextContent('Minor improvements needed.');
    expect(snapshot.querySelector('[data-testid="grade-chip"]')).toHaveTextContent('B');
  });

  it('states what was captured about the source, and what it means', async () => {
    await renderDetail();
    const snapshot = screen.getByTestId('catalog-detail-source-snapshot');
    expect(snapshot).toHaveTextContent('claims-837p-sample.edi');
    expect(snapshot).toHaveTextContent('File upload');
    expect(snapshot).toHaveTextContent('Content captured');
    expect(snapshot).toHaveTextContent('Downloadable');
  });

  it('reports "Reference only" rather than dropping the chip when no bytes were kept', async () => {
    await renderDetail({
      ...ITEM,
      source: { ...ITEM.source, hasContent: false, downloadable: false },
    });
    expect(screen.getByTestId('catalog-detail-source-snapshot')).toHaveTextContent(
      'Reference only',
    );
  });

  it('renders the parsed model as one card per group with its entity rows', async () => {
    await renderDetail();
    const group = screen.getByTestId('catalog-detail-parsed-group');
    expect(group).toHaveTextContent('Types');
    expect(within(group).getAllByTestId('catalog-detail-parsed-entity')).toHaveLength(2);
  });
});

describe('the Provenance pane', () => {
  it('draws the four steps with their fixed titles, in order', async () => {
    mockSearch = 'tab=provenance';
    await renderDetail();
    const rail = screen.getByTestId('catalog-detail-provenance');
    for (const [testId, title] of [
      ['catalog-detail-stage-intake', 'Source intake'],
      ['catalog-detail-stage-detection', 'Format detection'],
      ['catalog-detail-stage-normalization', 'Normalization'],
      ['catalog-detail-stage-record', 'Catalog record'],
    ] as const) {
      expect(within(rail).getByTestId(testId)).toHaveTextContent(title);
    }
    expect(rail).toHaveTextContent('x12-adapter 1.4.0');
    expect(rail).toHaveTextContent('job_2c9f4a71');
    expect(rail).toHaveTextContent('Ada Lovelace');
  });

  it('says which facts were never recorded rather than leaving the step blank', async () => {
    mockSearch = 'tab=provenance';
    await renderDetail({ ...ITEM, sourceFormat: null, protocol: null, toolVersions: null });
    const rail = screen.getByTestId('catalog-detail-provenance');
    expect(rail).toHaveTextContent('No detected format or protocol was recorded.');
    expect(rail).toHaveTextContent('Tool versions were not recorded for this import.');
  });
});

describe('the converted strip', () => {
  it('names the conversion, its version and its live target', async () => {
    await renderDetail();
    const strip = screen.getByTestId('catalog-detail-converted');
    expect(strip).toHaveTextContent('Re-converted to OpenAPI project');
    expect(strip).toHaveTextContent('ver_5c0d21');
    expect(within(strip).getByRole('link', { name: 'Claims 837P (OpenAPI)' })).toBeInTheDocument();
  });

  it('strikes a deleted target through instead of offering a dead link', async () => {
    await renderDetail({
      ...ITEM,
      conversion: { ...ITEM.conversion, projectDeleted: true },
    });
    const strip = screen.getByTestId('catalog-detail-converted');
    expect(within(strip).queryByRole('link')).not.toBeInTheDocument();
    const dead = strip.querySelector('.cid-converted__deleted')!;
    expect(dead).toHaveTextContent('Claims 837P (OpenAPI)');
    expect(dead).toHaveAttribute('title', 'The converted project was deleted');
  });

  it('draws nothing at all for an item that was never converted', async () => {
    await renderDetail({ ...ITEM, conversion: null });
    expect(screen.queryByTestId('catalog-detail-converted')).not.toBeInTheDocument();
  });

  it('follows "View conversion history" to the Conversions pane', async () => {
    await renderDetail();
    fireEvent.click(screen.getByTestId('catalog-detail-converted-history-link'));
    expect(screen.getByTestId('catalog-detail-tab-conversions')).toHaveAttribute(
      'aria-selected',
      'true',
    );
  });
});

describe('a deleted item', () => {
  const DELETED = { ...ITEM, deleted_at: '2026-08-16T10:00:00.000Z' };

  it('hides the two verbs that would write, and keeps the one that reads', async () => {
    await renderDetail(DELETED);
    expect(screen.queryByTestId('catalog-detail-convert')).not.toBeInTheDocument();
    expect(screen.queryByTestId('catalog-detail-export')).not.toBeInTheDocument();
    expect(screen.getByTestId('catalog-detail-view-code')).toBeInTheDocument();
  });

  it('says Deleted in the header badge', async () => {
    await renderDetail(DELETED);
    expect(screen.getByTestId('catalog-detail-status')).toHaveTextContent('Deleted');
  });
});

describe('the states', () => {
  it('holds the reader with a live region while the item loads', () => {
    mockReads(ITEM);
    render(<CatalogItemDetailClient itemId={ITEM.id} />);
    expect(screen.getByText('Loading catalog item…')).toBeInTheDocument();
  });

  it('offers a retry and a way back when the item cannot be read', async () => {
    mockReads(null, false);
    render(<CatalogItemDetailClient itemId={ITEM.id} />);
    const error = await screen.findByTestId('catalog-detail-error');
    expect(error).toHaveTextContent(/not found/i);
    fireEvent.click(within(error).getByRole('button', { name: 'Back to Catalog' }));
    expect(mockPush).toHaveBeenCalledWith('/ade/dashboard/catalog');
  });

  it('never offers Publish — a catalog item is the non-publishable slice of projects', async () => {
    await renderDetail();
    expect(screen.queryByText(/publish/i)).not.toBeInTheDocument();
  });
});

/**
 * `e2e/hive-catalog-item.spec.ts` measures this screen in a real browser — no horizontal
 * document scroll across the nine themes, both densities and all six font scales, and axe —
 * against markup the components actually render. That markup is written here, from the very
 * renders this suite pins, into `e2e/fixtures/hive-catalog-item/` when
 * `CATALOG_ITEM_FIXTURE_DUMP=1` is set:
 *
 *     CATALOG_ITEM_FIXTURE_DUMP=1 npx jest -c jest.config.ts \
 *       tests/catalog-item-detail-hive.test.tsx -t fixtures
 *
 * Without the variable the test still runs — it renders every surface and checks each is there
 * — so a change to a component that would leave the fixtures stale fails loudly here before it
 * fails quietly in the browser.
 */
describe('the browser fixtures', () => {
  const OUT = path.join(__dirname, '..', 'e2e', 'fixtures', 'hive-catalog-item');
  const dump = process.env.CATALOG_ITEM_FIXTURE_DUMP === '1';

  /** Write one fixture, or just assert it could be. */
  const write = (name: string, html: string) => {
    expect(html.length).toBeGreaterThan(0);
    if (!dump) return;
    fs.mkdirSync(OUT, { recursive: true });
    fs.writeFileSync(path.join(OUT, `${name}.html`), html);
  };

  /** The page column the shell would put this screen in. */
  const page = () => document.querySelector('.page') as HTMLElement;

  it('renders every surface the browser spec mounts (and writes the fixtures on request)', async () => {
    await renderDetail();

    // Overview — the pane a reader lands on, and the widest grid on the screen.
    write('overview', page().outerHTML);

    // Provenance — the four-step rail, whose connector is the thing the browser measures.
    fireEvent.click(screen.getByTestId('catalog-detail-tab-provenance'));
    await waitFor(() => expect(screen.getByTestId('catalog-detail-pane-provenance')).toBeVisible());
    write('provenance', page().outerHTML);

  });

  it('writes the deleted surface, whose header has lost its two writing verbs', async () => {
    await renderDetail({
      ...ITEM,
      deleted_at: '2026-08-16T10:00:00.000Z',
      conversion: { ...ITEM.conversion, projectDeleted: true },
    });
    write('deleted', page().outerHTML);
  });

  /**
   * The two format inspectors, which the ticket's *first* acceptance criterion is about:
   * "Both inspectors render their hierarchies without horizontal page scroll."
   *
   * They are written from the Format details pane rather than from the whole screen because
   * the pane fetches its analysis record lazily — the record has to be mocked, and mocking it
   * through the screen would mean mocking the item read twice over. What the browser measures
   * is the pane in the page column it is drawn in, which is the width that matters.
   */
  describe('the format inspectors', () => {
    /** Route the two GETs the Format details pane makes. */
    const mockAnalysis = (record: AnalysisRecord) => {
      global.fetch = jest.fn(async (input: unknown) => {
        const url = String(input);
        if (url.includes('/format-capabilities')) {
          return {
            ok: true,
            status: 200,
            json: async () => ({ success: true, ...REGISTRY_SNAPSHOT }),
          };
        }
        if (url.includes('/analysis')) {
          return { ok: true, status: 200, json: async () => ({ success: true, record }) };
        }
        throw new Error(`unexpected fetch: ${url}`);
      }) as unknown as typeof fetch;
    };

    /** Mount the pane inside the page column the shell would draw it in. */
    const renderPane = async (record: AnalysisRecord, sourceFormat: string) => {
      resetFormatCapabilitiesCache();
      mockAnalysis(record);
      const { container } = render(
        <div className="page">
          <div className="page-body">
            <div className="cid-pane">
              <CatalogFormatDetailPanel
                itemId={ITEM.id}
                summary={{ ...AVAILABLE_SUMMARY, nodeCount: record.analysis.metrics.nodeCount }}
                sourceFormat={sourceFormat}
                active
                sourceAvailable
                onViewSourceLine={() => {}}
                nodeHref={(nodeId) => `/ade/dashboard/catalog/${ITEM.id}?tab=format&node=${nodeId}`}
              />
            </div>
          </div>
        </div>,
      );
      await waitFor(() => expect(screen.getByRole('tree')).toBeInTheDocument());
      return container;
    };

    it('writes the X12 interchange inspector', async () => {
      const container = await renderPane(x12ScannedRecord(), 'edix12');
      expect(screen.getByTestId('catalog-x12-inspector')).toBeInTheDocument();
      write('inspector-x12', (container.firstElementChild as HTMLElement).outerHTML);
    });

    it('writes the COBOL copybook inspector', async () => {
      const container = await renderPane(copybookLayoutRecord(), 'copybook');
      expect(screen.getByTestId('catalog-copybook-inspector')).toBeInTheDocument();
      write('inspector-copybook', (container.firstElementChild as HTMLElement).outerHTML);
    });
  });
});
