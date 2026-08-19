/**
 * Source-contract tests for the Catalog list screen (MFI-23.3, #4012; rebuilt HIVE-7.1, #5318).
 *
 * `catalog-model.test.ts` holds the decisions and `catalog-hive-redesign.test.tsx` renders the
 * screen. What is left here is the handful of invariants that are properties of the *source*
 * rather than of any one render: which endpoint it reaches, which writes it is allowed to make,
 * and the three things it must never grow.
 *
 * The screen is a client component behind a thin `page.tsx` since HIVE-7.1, so the assertions
 * read `CatalogClient.tsx` and the two view components beside it.
 */

import * as fs from 'fs';
import * as path from 'path';

const APP = path.resolve(__dirname, '..', 'src', 'app');
const ROUTE = path.join(APP, 'ade', 'dashboard', 'catalog');
const COMPONENTS = path.join(APP, 'components', 'ade', 'catalog');

const page = fs.readFileSync(path.join(ROUTE, 'page.tsx'), 'utf8');
const client = fs.readFileSync(path.join(ROUTE, 'CatalogClient.tsx'), 'utf8');
const card = fs.readFileSync(path.join(COMPONENTS, 'CatalogCard.tsx'), 'utf8');
const table = fs.readFileSync(path.join(COMPONENTS, 'CatalogTable.tsx'), 'utf8');
const model = fs.readFileSync(path.join(COMPONENTS, 'catalogModel.ts'), 'utf8');

describe('the route', () => {
  it('is a thin server wrapper over the client component', () => {
    expect(page).not.toMatch(/^'use client';/);
    expect(page).toContain("import CatalogClient from './CatalogClient'");
    expect(client).toMatch(/^'use client';/);
    expect(client).toContain('export default function CatalogClient');
  });
});

describe('data wiring', () => {
  it('reads the list from the /api/catalog proxy (MFI-23.2)', () => {
    expect(client).toContain('fetch(`/api/catalog${qs}`)');
    expect(client).toContain('data.catalog');
  });

  it('forwards include_deleted and identityGroupId', () => {
    expect(client).toContain("if (showDeleted) params.set('include_deleted', 'true')");
    expect(client).toContain(
      "if (identityGroupFilter) params.set('identityGroupId', identityGroupFilter)"
    );
  });

  it('reports a failed read instead of swallowing it into an empty list', () => {
    // The screen this replaced logged to the console and rendered "Your catalog is empty",
    // which made an unreachable API and an empty workspace look identical.
    expect(client).toContain('setLoadError(');
    expect(client).toContain('onRetry={() => void loadCatalog()}');
    // The mention that survives is the doc comment explaining what this replaced; no call does.
    expect(client).not.toMatch(/console\.error\(/);
  });
});

describe('the writes this screen is allowed to make', () => {
  it('reuses the project server actions — a catalog item id is a project id', () => {
    expect(client).toMatch(
      /import \{ deleteProject, permanentDeleteProject, restoreProject \} from '@lib\/db\/helper'/
    );
    expect(client).toContain('deleteProject(item.id)');
    expect(client).toContain('restoreProject(item.id)');
    expect(client).toContain('permanentDeleteProject(item.id)');
  });

  it('never creates or edits an item — items are minted by the import routing (MFI-23.7)', () => {
    for (const source of [client, card, table]) {
      expect(source).not.toMatch(/\bcreateProject\b|\bupdateProject\b/);
      expect(source).not.toMatch(/>\s*Edit item/);
    }
  });

  it('never publishes — the catalog is the non-publishable slice (MFI-23.1)', () => {
    // Word-boundaried so the domain term "non-publishable" (the banner) does not match.
    for (const source of [client, card, table, model]) {
      expect(source).not.toMatch(/>\s*Publish/);
      expect(source).not.toMatch(/\bonPublish\b|\bhandlePublish\b|\bpublishProject\b/);
    }
  });

  it('gates a permanent delete once, on the item slug, instead of twice on nothing', () => {
    expect(model).toContain('typeToConfirm: true');
    expect(model).toContain("confirmPhrase: item.slug?.trim() || item.name");
    expect(client).not.toContain('Final Confirmation');
  });
});

describe('the rules live in the model, not in the screen', () => {
  it('imports its narrowing, its sorting and its confirms from catalogModel', () => {
    for (const symbol of [
      'searchCatalog',
      'matchesCatalogFacet',
      'matchesCatalogFilters',
      'catalogFacetCounts',
      'catalogFormatFacetOptions',
      'sortCatalog',
      'catalogSummaryLine',
      'catalogBulkPlan',
      'softDeleteCatalogItemConfirm',
      'undeleteCatalogItemConfirm',
      'permanentDeleteCatalogItemConfirm',
    ]) {
      expect(client).toContain(symbol);
    }
  });

  it('derives a row menu from catalogRowActions rather than from deleted_at in the JSX', () => {
    expect(card).toContain('catalogRowActions(item)');
    // The two views share one menu component, so the seven verbs cannot drift apart.
    expect(table).toContain('CatalogRowMenu');
  });

  it('hands both views the same narrowed array', () => {
    expect(client).toMatch(/const visible = React\.useMemo\(/);
    expect(client).toContain('items={visible}');
    expect(client).toMatch(/visible\.map\(\(item\) => \(/);
  });
});

describe('the shared frames it sits in', () => {
  it('uses the page chrome and the shared list table', () => {
    expect(client).toContain("from '@/app/components/shell/PageHeader'");
    expect(client).toContain("from '@/app/components/shell/pageChrome'");
    expect(table).toContain("from '@/app/components/ui/DataTable'");
  });

  it('shares the HIVE-6.4 import wizard frame rather than copying it', () => {
    const wizard = fs.readFileSync(
      path.join(APP, 'components', 'ade', 'dashboard', 'catalog', 'CatalogImportDialog.tsx'),
      'utf8'
    );
    expect(wizard).toMatch(/ImportWizardHead[\s\S]*?from '\.\.\/\.\.\/import'/);
    for (const piece of [
      '<ImportWizardHead',
      '<ImportWizardSteps',
      '<ImportWizardBody>',
      '<ImportWizardFooter',
      '<ImportSourceCards',
    ]) {
      expect(wizard).toContain(piece);
    }
    expect(wizard).toContain('className="imp-wizard"');
  });

  it('persists the four toolbar preferences (MFI-28.4)', () => {
    expect(client).toContain('loadCatalogViewPreferences()');
    expect(client).toContain('persistCatalogViewPreferences({');
    expect(client).toMatch(/persistCatalogViewPreferences[\s\S]{0,220}?\[groupMode, showDeleted, sort, view\]/);
  });
});
