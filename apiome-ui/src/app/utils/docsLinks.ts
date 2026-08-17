/**
 * Where a written guide lives, spelled once (HIVE-4.9, #5303).
 *
 * The guide set is markdown in the repository (`docs/guide/*.md`), not a route this app
 * serves, so every "read the guide" affordance ends up building the same GitHub blob URL.
 * Three places were building it independently — the lint rule catalog, the governance axis
 * panels, and now the Help & docs page — each with its own copy of the base string. A fourth
 * copy is how a repository rename ships a page of dead links.
 *
 * The two callers that predate this module keep their own exported builders
 * (`buildLintRuleDocsHref`, `buildGovernanceDocsHref`), because each applies its own default
 * page before delegating here; what they no longer keep is the URL.
 */

/** Blob root of the default branch — the prefix every `docs/…` path hangs off. */
export const GITHUB_DOCS_BASE = 'https://github.com/apiome/apiome/blob/main/';

/**
 * Build an external link to a documentation page in the repository.
 *
 * @param docsPage Repository-relative path, e.g. `docs/guide/import-a-spec.md`. A leading
 *   slash is tolerated and stripped, since the REST API returns the path both ways.
 * @param docsAnchor Optional heading anchor within the page, without the `#`. Blank,
 *   whitespace-only and absent are all treated as "no anchor".
 * @returns The absolute URL. Never relative: these open in a new tab, away from the app.
 */
export function buildDocsHref(docsPage: string, docsAnchor?: string | null): string {
  const page = docsPage.replace(/^\//, '');
  const anchor = (docsAnchor ?? '').trim();
  return anchor ? `${GITHUB_DOCS_BASE}${page}#${anchor}` : `${GITHUB_DOCS_BASE}${page}`;
}
