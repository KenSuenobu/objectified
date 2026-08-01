/**
 * Shared presentation for spec format families across the repository surfaces.
 *
 * Two views render the same fact in the same pill: the per-repository Files browser
 * (REPO-6.2), which only has REST's `display_kind` string, and the cross-repo spec catalog
 * (REPO-6.4), which has the normalized `format` family key. Both resolve to the palette below
 * so one spec type never reads as two different colours depending on which page you opened.
 */

/**
 * Format family keys, mirroring `SPEC_FORMAT_LABELS` in
 * `apiome-rest/src/app/repository_spec_catalog.py`. Kept as a plain union so a typo in a
 * consumer is a compile error rather than a silently grey pill.
 */
export type RepositorySpecFormat =
  | 'openapi'
  | 'arazzo'
  | 'asyncapi'
  | 'json_schema'
  | 'graphql'
  | 'protobuf'
  | 'postman'
  | 'sql_ddl'
  | 'prisma'
  | 'avro'
  | 'dbml'
  | 'other'
  | 'unclassified';

/** Pill classes used when a format has no palette entry of its own. */
const NEUTRAL_PILL = 'bg-gray-100 text-gray-700 dark:bg-gray-700 dark:text-gray-300';

/** Family → pill classes. Every entry has a light and a dark pairing; no bare hex anywhere. */
const FORMAT_PILL_CLASSES: Record<string, string> = {
  openapi: 'bg-emerald-100 text-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-300',
  arazzo: 'bg-indigo-100 text-indigo-700 dark:bg-indigo-900/40 dark:text-indigo-300',
  asyncapi: 'bg-cyan-100 text-cyan-700 dark:bg-cyan-900/40 dark:text-cyan-300',
  json_schema: 'bg-purple-100 text-purple-700 dark:bg-purple-900/40 dark:text-purple-300',
  graphql: 'bg-pink-100 text-pink-700 dark:bg-pink-900/40 dark:text-pink-300',
  protobuf: 'bg-amber-100 text-amber-800 dark:bg-amber-900/40 dark:text-amber-200',
  postman: 'bg-amber-100 text-amber-800 dark:bg-amber-900/40 dark:text-amber-200',
  sql_ddl: 'bg-amber-100 text-amber-800 dark:bg-amber-900/40 dark:text-amber-200',
  prisma: 'bg-teal-100 text-teal-700 dark:bg-teal-900/40 dark:text-teal-300',
  avro: 'bg-sky-100 text-sky-700 dark:bg-sky-900/40 dark:text-sky-300',
  dbml: 'bg-teal-100 text-teal-700 dark:bg-teal-900/40 dark:text-teal-300',
};

/**
 * Pill classes for a normalized format family key.
 *
 * @param format - A family key from REST, e.g. `openapi`. Unknown and unclassified keys get
 *   the neutral pill rather than throwing — a family added server-side must still render.
 * @returns Tailwind classes for the pill.
 */
export function repositoryFormatPillClass(format: string): string {
  return FORMAT_PILL_CLASSES[format.trim().toLowerCase()] ?? NEUTRAL_PILL;
}

/**
 * Pill classes for REST's human `display_kind` string, e.g. `OpenAPI`, `JSON Schema`.
 *
 * Used by the per-repository Files listing, whose rows predate the catalog's family key. The
 * match is a substring test because `display_kind` carries variants such as
 * `JSON (unclassified)` and title-cased fallbacks derived from the raw detected kind.
 *
 * @param displayKind - REST's display kind for the row.
 * @returns Tailwind classes for the pill — identical to what
 *   {@link repositoryFormatPillClass} returns for the equivalent family.
 */
export function repositoryDisplayKindPillClass(displayKind: string): string {
  const k = (displayKind || '').toLowerCase();
  if (k.includes('openapi')) return FORMAT_PILL_CLASSES.openapi;
  if (k.includes('arazzo')) return FORMAT_PILL_CLASSES.arazzo;
  if (k.includes('asyncapi')) return FORMAT_PILL_CLASSES.asyncapi;
  if (k.includes('json schema')) return FORMAT_PILL_CLASSES.json_schema;
  if (k.includes('graphql')) return FORMAT_PILL_CLASSES.graphql;
  if (k.includes('protobuf') || k.includes('postman') || k.includes('sql')) {
    return FORMAT_PILL_CLASSES.protobuf;
  }
  return NEUTRAL_PILL;
}
