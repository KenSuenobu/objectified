/**
 * Versions screen Import button (#5260) — source-level contract.
 *
 * The Versions header must offer the same importer the Projects header does, placed between the
 * project selector and *Compare*, so an import no longer requires backtracking to Projects. The
 * page component is a monolith that cannot be mounted in jsdom, so this pins the wiring at the
 * source level (the pattern the auth route-contract tests use); the rendered behaviour is covered
 * by `e2e/versions-import.spec.ts`, and the post-import selection logic by
 * `tests/unit/versions-imported-project.test.ts`.
 */
import * as fs from 'fs';
import * as path from 'path';

const VERSIONS_PAGE = path.join(
  __dirname,
  '..',
  'src',
  'app',
  'ade',
  'dashboard',
  'versions',
  'page.tsx',
);

const source = fs.readFileSync(VERSIONS_PAGE, 'utf8');

/** Index of a marker in the page source; fails loudly rather than comparing a silent -1. */
const at = (marker: string): number => {
  const index = source.indexOf(marker);
  expect({ marker, found: index >= 0 }).toEqual({ marker, found: true });
  return index;
};

describe('Versions header Import button', () => {
  it('sits between the project selector and the Compare button', () => {
    const selector = at('placeholder="Select Project"');
    const importButton = at('data-testid="versions-import-button"');
    const compare = at('onClick={handleCompareDialogOpen}');

    expect(importButton).toBeGreaterThan(selector);
    expect(compare).toBeGreaterThan(importButton);
  });

  it('opens the shared import dialog rather than a second importer', () => {
    expect(source).toContain(
      "import ImportDialog from '../../../components/ade/dashboard/ImportDialog'",
    );
    expect(source).toContain('onClick={() => setShowImportDialog(true)}');
    expect(source).toContain('open={showImportDialog}');
  });

  it('renders the importer only with a resolved tenant and user, on the projects variant', () => {
    const dialog = source.slice(at('<ImportDialog'), at('<ImportDialog') + 400);
    expect(source).toContain('{currentTenantId && currentUserId && (');
    expect(dialog).toContain('tenantId={currentTenantId}');
    expect(dialog).toContain('userId={currentUserId}');
    // MFI-23.12: Projects owns native OpenAPI/Swagger intake; alternatives stay on Catalog.
    expect(dialog).toContain('variant="projects"');
    expect(dialog).toContain('onSuccess={handleImportSuccess}');
  });

  it('switches the selector to the project a completed import created', () => {
    expect(source).toContain(
      "import { findNewlyImportedProject } from './imported-project'",
    );
    const handler = source.slice(
      at('const handleImportSuccess = async () => {'),
      at('const handleImportSuccess = async () => {') + 600,
    );
    expect(handler).toContain('findNewlyImportedProject(before, refreshed)');
    expect(handler).toContain('handleSelectedProjectChange(imported.id)');
    // Falls back to refreshing the open project's revisions when no new project can be named.
    expect(handler).toContain('await loadVersions()');
  });
});
