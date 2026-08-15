/**
 * Newly-imported project resolution for the Versions screen (#5260).
 *
 * The Versions header can start an import without backtracking to Projects. A spec import always
 * lands in a *new* project, so once the importer closes the page reloads its project list and needs
 * to know which entry appeared in order to switch the selector to it. The import dialog reports only
 * "an import landed" (no id), so the answer is derived by diffing the project list across the
 * reload.
 */

import { isProjectPublishable } from '@/app/utils/catalog-publishable';

/** The minimal project shape this diff needs: an id plus the catalog/publishable flag. */
export interface ImportedProjectCandidate {
  id: string;
  publishable?: boolean | null;
}

/**
 * Find the project an import just created by diffing the project list across a reload.
 *
 * Only publishable projects qualify: catalog items (`publishable === false`) are browsed from
 * Dashboard → Catalog and are never auto-selected on the Versions screen (#4587). When the reload
 * shows more than one new publishable project — another tab or teammate created one concurrently —
 * no guess is made, so the selection is left where the user put it rather than jumping somewhere
 * unrelated.
 *
 * @param before Projects known before the import (only `id` is read).
 * @param after Projects returned by the reload that followed the import.
 * @returns The single newly added publishable project, or `null` when none or several appeared.
 */
export function findNewlyImportedProject<T extends ImportedProjectCandidate>(
  before: readonly ImportedProjectCandidate[],
  after: readonly T[],
): T | null {
  const knownIds = new Set(before.map((p) => p.id));
  const added = after.filter((p) => !knownIds.has(p.id) && isProjectPublishable(p));
  return added.length === 1 ? added[0] : null;
}
