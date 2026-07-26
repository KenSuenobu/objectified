/**
 * Source-contract tests for the Catalog dashboard screen (MFI-23.3, #4012).
 *
 * The Catalog screen is cloned from the Projects dashboard and is heavy on app-router / next-auth /
 * dialog-provider wiring, so — matching the project's convention for the Projects page and the
 * `catalog-proxy.test.ts` proxy tests — these assert the source-level contract the feature depends
 * on rather than standing up the full render stack: the route exists, reaches `/api/catalog`,
 * offers card/table views, the four filter chips, the six sort options, search, soft-delete /
 * undelete via the reused project server actions, and an empty state that explains the catalog.
 * If the page drops one of these behaviours, this goes red.
 */

import * as fs from 'fs';
import * as path from 'path';

const PAGE = path.resolve(__dirname, '..', 'src', 'app', 'ade', 'dashboard', 'catalog', 'page.tsx');
const src = fs.readFileSync(PAGE, 'utf8');

describe('catalog screen route', () => {
  it('exists at /ade/dashboard/catalog and is a default-exported client component', () => {
    expect(fs.existsSync(PAGE)).toBe(true);
    expect(src).toMatch(/^'use client';/);
    expect(src).toMatch(/export default Catalog/);
  });
});

describe('data wiring', () => {
  it('reads the catalog list from the /api/catalog proxy (MFI-23.2)', () => {
    expect(src).toMatch(/fetch\(`\/api\/catalog\$\{qs\}`\)/);
    expect(src).toContain('data.catalog');
  });

  it('forwards include_deleted and identityGroupId query params', () => {
    expect(src).toContain("if (showDeleted) params.set('include_deleted', 'true')");
    expect(src).toContain("if (identityGroupFilter) params.set('identityGroupId', identityGroupFilter)");
  });

  it('does not create or edit items (catalog is read-only here)', () => {
    expect(src).not.toMatch(/createProject|updateProject/);
    expect(src).not.toContain('Create item');
    expect(src).not.toContain('Edit item');
  });
});

describe('soft-delete / undelete via reused project server actions', () => {
  it('imports the project delete/restore/permanent-delete helpers', () => {
    expect(src).toMatch(/import\s*\{[^}]*deleteProject[^}]*\}\s*from\s*'.*lib\/db\/helper'/s);
    expect(src).toContain('restoreProject');
    expect(src).toContain('permanentDeleteProject');
  });

  it('wires delete, undelete and permanent-delete handlers', () => {
    expect(src).toContain('await deleteProject(itemId)');
    expect(src).toContain('await restoreProject(item.id)');
    expect(src).toContain('await permanentDeleteProject(item.id)');
  });

  it('double-confirms a permanent delete', () => {
    expect(src).toContain('Final Confirmation');
  });
});

describe('views, filters, sort and search', () => {
  it('offers a card/table view toggle', () => {
    expect(src).toContain("setViewMode('cards')");
    expect(src).toContain("setViewMode('table')");
  });

  it('offers all four filter chips', () => {
    for (const chip of ['all', 'active', 'attention', 'deleted']) {
      expect(src).toContain(`setFilterChip('${chip}')`);
    }
  });

  it('exposes exactly the six required sort options', () => {
    for (const col of ['name', 'created', 'updated', 'quality', 'grade', 'format']) {
      expect(src).toContain(`column: '${col}'`);
    }
  });

  it('sorts via the dedicated catalog sorter', () => {
    expect(src).toContain('sortCatalogDashboardRows');
  });

  it('has a search box that filters the list', () => {
    expect(src).toContain('setSearchQuery');
    expect(src).toMatch(/i\.name\.toLowerCase\(\)\.includes\(q\)/);
  });
});

describe('CatalogItemCard wiring (MFI-23.4)', () => {
  it('renders the card grid via the dedicated CatalogItemCard component', () => {
    expect(src).toContain("import { CatalogItemCard }");
    expect(src).toMatch(/<CatalogItemCard\b/);
  });

  it('passes a format/source pill slot (MFI-23.5) and an actions slot to the card', () => {
    expect(src).toMatch(/formatSlot=\{<CatalogFormatBadge/);
    expect(src).toMatch(/actionsSlot=\{/);
  });

  it('wires the quality orb to the server lint report when a server score exists', () => {
    expect(src).toContain('catalogQualityOpensServerLintReport');
    expect(src).toMatch(/handleOpenQuality[\s\S]{0,200}?setLintDialogItem\(item\)/);
    expect(src).toContain('ProjectQualityHistoryDialog');
    expect(src).toContain('onOpenQualityHistory={() => handleOpenQuality(item)}');
  });

  it('wires the lint orb to the server-backed CatalogLintReportDialog (MFI-23.10)', () => {
    expect(src).toContain('CatalogLintReportDialog');
    expect(src).toContain('onOpenLintReport={() => handleOpenLint(item)}');
    // The lint action opens the server report, not the browser-local quality dialog's lint tab.
    expect(src).toMatch(/handleOpenLint[\s\S]{0,80}?setLintDialogItem\(item\)/);
  });

  it('offers View / Lint / Convert actions but never Publish', () => {
    expect(src).toMatch(/<Eye[\s\S]{0,80}?>\s*View/);
    expect(src).toMatch(/<ScanLine[\s\S]{0,80}?>\s*Lint/);
    // The convert action label is derived (Convert vs Re-convert, OpenAPI Project vs Project) from
    // the item's conversion state and source format.
    expect(src).toContain('convertActionLabel(item.conversion, item.sourceFormat)');
    // No publish action label, handler or icon — the catalog is the non-publishable slice (MFI-23.1).
    // Word boundaries keep this targeted at publish *handlers*, so it doesn't false-positive on the
    // domain term "non-publishable" (e.g. the CatalogNonPublishableBanner identifier, MFI-24.3).
    expect(src).not.toMatch(/>\s*Publish/);
    expect(src).not.toMatch(/\bonPublish\b|\bhandlePublish\b|\bpublishProject\b/);
  });
});

describe('convert-to-project back-link (MFI-23.11)', () => {
  it('renders a ConvertedBadge slot on the card wired to the item conversion', () => {
    expect(src).toMatch(/conversionSlot=\{<ConvertedBadge conversion=\{item\.conversion\}/);
  });

  it('links the converted badge to the produced project via the shared helper', () => {
    expect(src).toContain('convertedProjectHref');
    expect(src).toContain('convertedProjectLabel');
  });

  it('shows the converted badge in the table view too', () => {
    expect(src).toMatch(/item\.conversion \? \([\s\S]{0,200}?<ConvertedBadge conversion=\{item\.conversion\}/);
  });
});

describe('detail navigation (MFI-23.9)', () => {
  it('navigates to the catalog item detail route on open-detail', () => {
    expect(src).toMatch(/handleOpenDetail[\s\S]{0,120}?\/ade\/dashboard\/catalog\/\$\{encodeURIComponent\(item\.id\)\}/);
  });

  it('opens the detail view from the card body click', () => {
    expect(src).toContain('onOpenDetail={() => handleOpenDetail(item)}');
  });

  it('offers a Details action distinct from View (which still goes to versions)', () => {
    expect(src).toMatch(/<PanelsTopLeft[\s\S]{0,80}?>\s*Details/);
    expect(src).toContain('onOpenDetail={handleOpenDetail}');
    expect(src).toMatch(/handleView[\s\S]{0,120}?\/ade\/dashboard\/versions\?projectId=/);
  });
});

describe('stats row (MFI-24.1)', () => {
  it('renders the four-card stats row above the filter/sort toolbar', () => {
    expect(src).toContain("import { CatalogStatsRow }");
    expect(src).toMatch(/<CatalogStatsRow items=\{items\}/);
    // The stats row must precede the "Views:" toolbar section in source order.
    const rowIdx = src.indexOf('<CatalogStatsRow');
    const toolbarIdx = src.indexOf('Views:');
    expect(rowIdx).toBeGreaterThan(-1);
    expect(toolbarIdx).toBeGreaterThan(rowIdx);
  });

  it('reduces the header subtitle to a static description (metrics moved to the cards)', () => {
    expect(src).not.toMatch(/parts\.push\(`\$\{active\} active`\)/);
    expect(src).toContain("headerSubtitle = 'OpenAPI-worthy non-OpenAPI imports'");
  });
});

describe('paradigm grouping (MFI-24.2)', () => {
  it('sections the card view via the dedicated paradigm grouper', () => {
    expect(src).toContain("import { groupCatalogItemsByParadigm }");
    expect(src).toContain('groupCatalogItemsByParadigm(displayedItems)');
  });

  it('offers a Group control with Protocol and None options, defaulting to Protocol', () => {
    // Group mode is now hydrated from the persisted view preferences (MFI-28.4); its default is
    // Protocol, defined in DEFAULT_CATALOG_VIEW_PREFERENCES (asserted in catalog-view-preferences).
    expect(src).toContain('useState<CatalogGroupMode>(viewPrefsHydrated.groupMode)');
    expect(src).toMatch(/mode: 'protocol', label: 'Protocol'/);
    expect(src).toMatch(/mode: 'none', label: 'None'/);
    expect(src).toContain("data-testid={`catalog-group-${opt.mode}`}");
  });

  it('renders a header (label + live count + divider) per paradigm section', () => {
    expect(src).toContain('data-testid={`catalog-paradigm-group-${group.id}`}');
    expect(src).toMatch(/\{group\.label\}/);
    expect(src).toMatch(/\{group\.items\.length\} item\{group\.items\.length === 1 \? '' : 's'\}/);
  });

  it('groups only the card view; Group=None reproduces the flat grid and the table stays flat', () => {
    // The grouped branch is gated on card view + protocol mode; None maps displayedItems flatly.
    expect(src).toMatch(/groupMode === 'protocol' \? \(/);
    expect(src).toMatch(/\) : \(\s*<section className="grid grid-cols-1 gap-5[^"]*">\s*\{displayedItems\.map\(renderCatalogCard\)\}/);
    // The Group control is hidden while the (always-flat) table view is active.
    expect(src).toMatch(/viewMode === 'cards' \? \(\s*<>\s*<span[^>]*>\s*Group:/);
  });
});

describe('table column parity (MFI-24.4)', () => {
  it('renders the 8 mockup columns in order: Artifact / Format / Protocol / Source / Quality / Grade / Status / Updated', () => {
    const headers = ['Artifact', 'Format', 'Protocol', 'Source', 'Quality', 'Grade', 'Status', 'Updated'];
    // Each header is a sortable <CatalogSortTh>; assert the labels occur in the documented order.
    const positions = headers.map((h) => src.indexOf(`\n                            ${h}\n`));
    for (const [i, pos] of positions.entries()) {
      expect(pos).toBeGreaterThan(-1);
      if (i > 0) expect(pos).toBeGreaterThan(positions[i - 1]);
    }
  });

  it('makes every data column header a sort control wired to the shared handler', () => {
    const columns = [
      'name',
      'format',
      'protocol',
      'source',
      'quality',
      'grade',
      'status',
      'updated',
    ];
    for (const column of columns) {
      expect(src).toContain(`column="${column}"`);
      expect(src).toContain(`testId="catalog-col-sort-${column}"`);
    }
    // The headers drive the same handler (and therefore the same persisted state) as the toolbar
    // chips, and each <th> reports its state through aria-sort.
    expect(src).toMatch(/onSortClick=\{handleSortClick\}/);
    expect(src).toMatch(/aria-sort=\{active \? \(sortDirection === 'asc' \? 'ascending' : 'descending'\) : 'none'\}/);
  });

  it('toggles the direction through the pure sort-state helper, not a nested setState', () => {
    // The direction flip has to be computed from the current state and written with plain setters.
    // Calling setSortDirection from inside a setSortColumn updater queues the toggle twice under
    // StrictMode, which pins the column to one direction forever (the behaviour of this regex is
    // the regression guard, not a style preference).
    expect(src).toContain('nextCatalogDashboardSort');
    expect(src).toMatch(
      /const next = nextCatalogDashboardSort\(\{ column: sortColumn, direction: sortDirection \}, column\);\s*setSortColumn\(next\.column\);\s*setSortDirection\(next\.direction\);/,
    );
    expect(src).not.toMatch(/setSortColumn\(\(prevCol\)/);
  });

  it('drops the Description / Created By / Created columns to match the 8-column set', () => {
    expect(src).not.toContain('>Description</th>');
    expect(src).not.toContain('>Created By</th>');
    expect(src).not.toContain('>Created</th>');
  });

  it('splits the bundled format cell into dedicated Format, Protocol and Source columns', () => {
    expect(src).toMatch(/<FormatPill format=\{item\.sourceFormat\}/);
    expect(src).toMatch(/<ProtocolPill protocol=\{item\.protocol\}/);
    expect(src).toMatch(/resolveCatalogSource\(item\.formatMetadata, item\.metadata\)[\s\S]{0,120}?<SourceBadge source=\{source\}/);
  });

  it('adds a Grade column driven by the shared GradeChip + orb score resolution', () => {
    expect(src).toContain("import { GradeChip }");
    expect(src).toContain('catalogOrbScores(');
    expect(src).toContain('<GradeChip grade={lintLetter}');
  });

  it('wires the table Quality and Grade cells to the same dialogs as the card orbs', () => {
    expect(src).toMatch(
      /qualityValue != null[\s\S]{0,120}?\(\) => handleOpenQuality\(item\)/,
    );
    expect(src).toMatch(/lintLetter[\s\S]{0,200}?\(\) => handleOpenLint\(item\)/);
    expect(src).toMatch(/<CatalogQualityBadge[\s\S]{0,120}?score=\{qualityValue\}/);
  });

  it('renders the .av.sm avatar (initials + gradient) in the artifact cell', () => {
    expect(src).toMatch(/catalogCardGradientClass\(item\.id\)[\s\S]{0,120}?catalogCardInitials\(item\.name\)/);
  });
});

describe('empty state', () => {
  it('explains what the catalog is and how items get here', () => {
    expect(src).toContain('Your catalog is empty');
    expect(src).toMatch(/non-OpenAPI/);
  });
});

describe('unified toolbar + persisted view preferences (MFI-28.4)', () => {
  it('consolidates every list control into a single sticky toolbar', () => {
    // One toolbar element, sticky, tagged for tests.
    expect(src).toContain('data-testid="catalog-toolbar"');
    expect(src).toMatch(/data-testid="catalog-toolbar"[\s\S]{0,200}?sticky top-0/);
    // The header no longer carries the search / view / show-deleted cluster — those now live in the
    // toolbar. The header keeps only the Import action.
    expect(src).toMatch(/header keeps only the primary Import action/);
  });

  it('hosts search, view toggle and show-deleted inside the toolbar (not the header)', () => {
    // All three controls appear after the toolbar marker in source order.
    const toolbarIdx = src.indexOf('data-testid="catalog-toolbar"');
    expect(toolbarIdx).toBeGreaterThan(-1);
    // Markers that occur only where the control is rendered (not at the state declaration).
    for (const needle of ['placeholder="Filter catalog…"', "setViewMode('cards')", 'id="catalog-show-deleted"']) {
      expect(src.indexOf(needle)).toBeGreaterThan(toolbarIdx);
    }
  });

  it('hydrates view/group/sort/show-deleted from persisted preferences', () => {
    expect(src).toContain("import {\n  loadCatalogViewPreferences,");
    expect(src).toContain('useState(() => loadCatalogViewPreferences())');
    expect(src).toContain('useState(viewPrefsHydrated.showDeleted)');
    expect(src).toContain('useState<CatalogDashboardSortColumn>(viewPrefsHydrated.sortColumn)');
    expect(src).toContain('viewPrefsHydrated.sortDirection');
    expect(src).toContain("useState<'cards' | 'table'>(viewPrefsHydrated.viewMode)");
    expect(src).toContain('useState<CatalogGroupMode>(viewPrefsHydrated.groupMode)');
  });

  it('persists the four preferences whenever any of them changes', () => {
    expect(src).toContain('persistCatalogViewPreferences({ viewMode, groupMode, sortColumn, sortDirection, showDeleted })');
    expect(src).toMatch(/persistCatalogViewPreferences[\s\S]{0,160}?\[viewMode, groupMode, sortColumn, sortDirection, showDeleted\]/);
  });

  it('adds a format facet that filters items by the selected format(s)', () => {
    expect(src).toContain('import {\n  CatalogFormatFacet,');
    expect(src).toMatch(/<CatalogFormatFacet\b/);
    expect(src).toContain('options={availableFormats}');
    expect(src).toContain('selected={selectedFormats}');
    expect(src).toContain('onChange={setSelectedFormats}');
    // The filter keeps only items whose resolved format family is in the selection.
    expect(src).toContain('catalogFormatFamilyId(i.sourceFormat)');
    expect(src).toMatch(/selectedFormats\.length > 0/);
  });

  it('derives the available formats from the loaded list via format families', () => {
    expect(src).toContain('const availableFormats = useMemo<CatalogFormatOption[]>');
    expect(src).toContain('catalogFormatFamilyId(item.sourceFormat)');
  });
});
