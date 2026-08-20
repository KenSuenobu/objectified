/**
 * What the portal says about Apiome's format surface (FMT-1.6, #5417).
 *
 * The directory's hero used to name three formats — OpenAPI, Arazzo, JSON Schema — which was the
 * whole truth when it was written and has not been since. The honest claim is a measurement, and a
 * measurement typed into JSX is a claim about whichever day it was typed.
 *
 * So the copy is composed here from `FORMAT_COUNTS`, the module `app.format_counts` generates from
 * the import-source, emitter and capability registries. Nothing in this file contains a number:
 * registering an adapter moves the hero at the next build, and
 * `apiome-rest/tests/test_format_counts.py` fails if the generated module is stale or if a count is
 * ever typed back into guarded copy.
 *
 * Keeping the sentences here rather than inline in `HomeClient` also makes them unit-testable
 * without rendering a page (`lib/__tests__/formatSurface.test.ts`).
 */

import type { FormatCounts } from './generated/formatCounts';
import { FORMAT_COUNTS, FORMAT_PARADIGMS } from './generated/formatCounts';

/**
 * The generated supported-formats reference page.
 *
 * An absolute URL because the portal does not serve the repository's `docs/` tree — the production
 * image ships the app, not the guide — so a relative link would 404 for every visitor.
 */
export const SUPPORTED_FORMATS_DOC_URL =
  'https://github.com/apiome/apiome/blob/main/docs/guide/supported-formats.md';

/**
 * The headline claim: how many formats Apiome reads, how many it writes, and that the conversions
 * between them are any-to-any.
 *
 * @param counts The measured counts; defaults to the generated ones and is injectable for tests.
 * @returns A sentence fragment of the shape `<n> formats in, <n> out — any-to-any`.
 */
export function describeFormatSurface(counts: FormatCounts = FORMAT_COUNTS): string {
  return `${counts.importable} formats in, ${counts.exportable} out — any-to-any`;
}

/**
 * The paradigm vocabulary, spelled out for prose.
 *
 * Reads the generated paradigm list rather than a local sentence, so the portal names exactly the
 * paradigms the facet offers and the matrix filters on.
 *
 * @param paradigms The paradigm rows; defaults to the generated list.
 * @returns Something like `REST, RPC, Event-driven, Graph, Data schema and Agent`.
 */
export function describeParadigms(
  paradigms: readonly { label: string }[] = FORMAT_PARADIGMS
): string {
  const labels = paradigms.map((paradigm) => paradigm.label).filter(Boolean);
  if (labels.length === 0) return '';
  if (labels.length === 1) return labels[0];
  return `${labels.slice(0, -1).join(', ')} and ${labels[labels.length - 1]}`;
}
