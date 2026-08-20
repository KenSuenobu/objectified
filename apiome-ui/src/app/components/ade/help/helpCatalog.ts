/**
 * The guide set, and the search over it (HIVE-4.9, #5303).
 *
 * Authority: `docs/mockups/foundations/help.html` — *"Search the guide… e.g. publish a
 * version, import RAML, MCP trust posture"* — and `docs/guide/README.md`, whose two tables
 * this file is the machine-readable form of.
 *
 * ### Why the guides are listed here rather than read from disk
 *
 * `docs/guide` is markdown in the repository, not a route this app serves. Reading the
 * directory at request time would need the docs tree inside the runtime image, which the
 * production `Dockerfile` does not ship, so a deployed instance would answer every search
 * with nothing. A listing compiled into the bundle searches instantly, works offline, and
 * costs one line per guide.
 *
 * The obvious failure mode of a hand-kept listing is drift — a guide is added and the search
 * never learns about it. `tests/help-catalog.test.ts` reads the real `docs/guide` directory
 * and fails when a file is missing from {@link GUIDE_ENTRIES} or names a page that no longer
 * exists, so the listing cannot silently fall behind the directory it describes.
 *
 * ### What a search matches
 *
 * Title, summary and keywords, so a reader who types the *task* ("publish", "gate a PR")
 * lands on the guide even when the title is phrased as a question. Every term has to match
 * something — narrowing a search by adding a word is the behaviour a search box promises —
 * and a title hit outranks a summary hit, which outranks a keyword hit.
 */

import { FORMAT_COUNTS } from '@/app/generated/formatCounts';
import { buildDocsHref } from '@/app/utils/docsLinks';

/**
 * Which of `docs/guide/README.md`'s two tables a guide belongs to.
 *
 * `spine` is the end-to-end path a specification travels — import, edit, lint, cut, publish,
 * browse, export. `reference` is everything consulted rather than followed.
 */
export type GuideSection = 'spine' | 'reference';

/** Human-readable headings for the two sections, used above grouped results. */
export const GUIDE_SECTION_LABELS: Readonly<Record<GuideSection, string>> = {
  spine: 'How do I…?',
  reference: 'References & quick-starts',
};

/** One page of the written guide set. */
export interface GuideEntry {
  /** Stable id: the React key, the test handle, and the file's basename. */
  id: string;
  /** The page's title, as its `h1` reads. */
  title: string;
  /** One line about what the page answers. Shown under the title in a result row. */
  summary: string;
  /** Repository-relative path, e.g. `docs/guide/import-a-spec.md`. */
  page: string;
  /** Which table of the guide index the page sits in. */
  section: GuideSection;
  /**
   * Words a reader might search for that the title and summary do not contain — the format
   * names, the product vocabulary, the synonyms. Never a repeat of the title: a term already
   * in the title scores higher through the title, and a duplicate would only inflate it.
   */
  keywords: readonly string[];
}

/**
 * Every page in `docs/guide`, in the order `docs/guide/README.md` presents them.
 *
 * The index itself is the last entry rather than the first: a reader searching for a task
 * wants the page that answers it, and "the whole guide" is what they fall back to.
 */
export const GUIDE_ENTRIES: readonly GuideEntry[] = [
  {
    id: 'import-a-spec',
    title: 'Import a specification',
    summary:
      `Import any of ${FORMAT_COUNTS.importable} formats — and which of the two importers, Projects or Catalog, handles yours.`,
    page: 'docs/guide/import-a-spec.md',
    section: 'spine',
    keywords: ['upload', 'swagger', 'openapi', 'arazzo', 'json schema', 'job', 'raml', 'postman'],
  },
  {
    id: 'edit-classes-and-properties',
    title: 'Edit classes & properties',
    summary:
      'Shape the data model your published spec exposes — a class becomes a component schema, its properties the fields.',
    page: 'docs/guide/edit-classes-and-properties.md',
    section: 'spine',
    keywords: ['schema', 'component', 'model', 'field', 'attribute', 'type'],
  },
  {
    id: 'edit-paths',
    title: 'Edit paths & operations',
    summary:
      'Author URL templates and their operations — parameters, request bodies and responses — on a specific version.',
    page: 'docs/guide/edit-paths.md',
    section: 'spine',
    keywords: ['endpoint', 'route', 'get', 'post', 'parameter', 'response', 'request body'],
  },
  {
    id: 'lint-and-quality',
    title: 'Lint & check quality',
    summary:
      'The server-side quality score (A–F out of 100) and the itemized findings behind it, so the UI and the CLI always agree.',
    page: 'docs/guide/lint-and-quality.md',
    section: 'spine',
    keywords: ['grade', 'score', 'style guide', 'severity', 'finding', 'governance'],
  },
  {
    id: 'axis-score',
    title: 'Axis score algorithm (clx-axis-v1)',
    summary:
      'How catalog and MCP lint evidence rolls into a multi-axis evaluation, and what each band means.',
    page: 'docs/guide/axis-score.md',
    section: 'spine',
    keywords: ['coverage', 'weighting', 'band', 'evidence', 'grade', 'rollup'],
  },
  {
    id: 'cut-a-version',
    title: 'Cut a version',
    summary:
      'Create a new revision of a project — classes carry over, paths are authored on the new revision.',
    page: 'docs/guide/cut-a-version.md',
    section: 'spine',
    keywords: ['revision', 'semver', 'branch', 'draft', 'base'],
  },
  {
    id: 'publish-a-version',
    title: 'Publish a version',
    summary:
      'Freeze a version for browse, export and MCP consumers — and the publish gates that refuse one that is not ready.',
    page: 'docs/guide/publish-a-version.md',
    section: 'spine',
    keywords: ['release', 'gate', 'freeze', 'public', 'private', 'ship'],
  },
  {
    id: 'browse-published-specs',
    title: 'Browse published specs',
    summary:
      'The read surface for published versions: public ones need no authentication, private ones an in-scope API key.',
    page: 'docs/guide/browse-published-specs.md',
    section: 'spine',
    keywords: ['catalog', 'discover', 'search', 'public', 'api key'],
  },
  {
    id: 'export-a-spec',
    title: 'Export / download a spec',
    summary:
      'Reconstruct the full OpenAPI 3.1, Arazzo or JSON Schema document for a published version, in JSON or YAML.',
    page: 'docs/guide/export-a-spec.md',
    section: 'spine',
    keywords: ['fetch', 'yaml', 'json', 'bundle', 'artifact', 'save'],
  },
  {
    id: 'export-fidelity',
    title: 'Understand export fidelity',
    summary:
      'What a projection to another format preserves, downgrades or drops — predicted before generation, with reasons.',
    page: 'docs/guide/export-fidelity.md',
    section: 'spine',
    keywords: [
      'projection',
      'asyncapi',
      'graphql',
      'proto3',
      'avro',
      'lossy',
      'acknowledgement',
      'reason code',
    ],
  },
  {
    id: 'catalog-format-details',
    title: "Read a catalog item's format details",
    summary:
      'Payload analysis for an imported item: X12 envelopes and segments, COBOL copybooks, statuses and redaction.',
    page: 'docs/guide/catalog-format-details.md',
    section: 'spine',
    keywords: ['x12', 'edi', 'cobol', 'copybook', 'redaction', 'payload', 'analysis'],
  },
  {
    id: 'convert-to-openapi',
    title: 'Convert a catalog item to OpenAPI',
    summary:
      'The evidence-first conversion: a deterministic projection map and its reason codes before anything is created.',
    page: 'docs/guide/convert-to-openapi.md',
    section: 'spine',
    keywords: ['projection graph', 'evidence', 'reason code', 'history', 'promote'],
  },
  {
    id: 'supported-formats',
    title: 'Supported formats',
    summary:
      'Every format Apiome imports and exports, generated from the registries — keys, input kinds, versions and extensions.',
    page: 'docs/guide/supported-formats.md',
    section: 'reference',
    keywords: [
      'protobuf',
      'grpc',
      'graphql',
      'asyncapi',
      'thrift',
      'smithy',
      'typespec',
      'wsdl',
      'xsd',
      'odata',
      'edi',
      'x12',
      'hl7',
      'fhir',
      'copybook',
      'matrix',
      'which formats',
    ],
  },
  {
    id: 'api-reference',
    title: 'API reference',
    summary:
      'The REST service publishes its own interactive reference — where it lives, and how to authenticate against it.',
    page: 'docs/guide/api-reference.md',
    section: 'reference',
    keywords: ['rest', 'swagger ui', 'fastapi', 'endpoint', 'openapi.json', 'token'],
  },
  {
    id: 'cli-quickstart',
    title: 'CLI quick-start',
    summary:
      'Import documents, inspect tenant resources, lint and export specs from the terminal with the apiome CLI.',
    page: 'docs/guide/cli-quickstart.md',
    section: 'reference',
    keywords: ['command line', 'terminal', 'shell', 'exit code', 'install', 'apiome diff'],
  },
  {
    id: 'mcp-quickstart',
    title: 'MCP setup quick-start',
    summary:
      'Point an MCP host — Claude Desktop, an IDE, automation — at your published specs, read-only.',
    page: 'docs/guide/mcp-quickstart.md',
    section: 'reference',
    keywords: ['model context protocol', 'claude desktop', 'ide', 'host', 'tool', 'stdio'],
  },
  {
    id: 'ci-diff-gate',
    title: 'CI contract gate (GitHub Action)',
    summary:
      'Gate pull requests when an OpenAPI change breaks a published version, with one sticky PR comment.',
    page: 'docs/guide/ci-diff-gate.md',
    section: 'reference',
    keywords: ['github actions', 'pipeline', 'breaking change', 'diff', 'pull request', 'workflow'],
  },
  {
    id: 'ci-gitlab-bitbucket',
    title: 'CI contract gate on GitLab & Bitbucket',
    summary:
      'The same diff gate as a copy-paste GitLab CI or Bitbucket Pipelines job, run from the container image.',
    page: 'docs/guide/ci-gitlab-bitbucket.md',
    section: 'reference',
    keywords: ['merge request', 'pipeline', 'container', 'docker', 'recipe'],
  },
  {
    id: 'lint-rules',
    title: 'Built-in lint rules',
    summary:
      'Reference for every rule in the catalog: stable ids, default severities and the rationale behind each one.',
    page: 'docs/guide/lint-rules.md',
    section: 'reference',
    keywords: ['rule id', 'severity', 'naming', 'catalog', 'registry'],
  },
  {
    id: 'custom-rules',
    title: 'Custom lint rules',
    summary:
      'Author organization-specific rules in a YAML dialect that is a strict subset of Spectral.',
    page: 'docs/guide/custom-rules.md',
    section: 'reference',
    keywords: ['spectral', 'dsl', 'yaml', 'organization', 'standard', 'validate'],
  },
  {
    id: 'spectral-import',
    title: 'Import a Spectral ruleset',
    summary:
      'Translate an existing .spectral.yaml into built-in and custom rules instead of re-authoring it.',
    page: 'docs/guide/spectral-import.md',
    section: 'reference',
    keywords: ['stoplight', 'redocly', 'migrate', 'yaml', 'convert'],
  },
  {
    id: 'style-guide-revisions',
    title: 'Style-guide revisions & governance audit',
    summary:
      'Every edit appends an immutable revision, so a lint score always names what the guide contained at the time.',
    page: 'docs/guide/style-guide-revisions.md',
    section: 'reference',
    keywords: ['history', 'immutable', 'compliance', 'pinned', 'trail'],
  },
  {
    id: 'mcp-conformance-rules',
    title: 'MCP conformance rules',
    summary: 'The conformance catalog, each rule citing the MCP specification reference it enforces.',
    page: 'docs/guide/mcp-conformance-rules.md',
    section: 'reference',
    keywords: ['specification', 'blocking', 'model context protocol', 'compliance'],
  },
  {
    id: 'mcp-surface-lint-rules',
    title: 'MCP surface lint rules',
    summary: 'What is checked about an MCP surface itself — tools, descriptions and transparency fields.',
    page: 'docs/guide/mcp-surface-lint-rules.md',
    section: 'reference',
    keywords: ['tool', 'transparency', 'model context protocol', 'description'],
  },
  {
    id: 'mcp-trust-posture-rules',
    title: 'MCP trust-posture rules',
    summary: 'Trust-posture checks mapped to the OWASP MCP Top 10, including the blocking ones.',
    page: 'docs/guide/mcp-trust-posture-rules.md',
    section: 'reference',
    keywords: ['owasp', 'security', 'risk', 'top 10', 'model context protocol'],
  },
  {
    id: 'mock-bundle-format',
    title: 'Portable mock bundle format',
    summary:
      'One JSON document pinning everything the mock runtime needs to serve a version offline.',
    page: 'docs/guide/mock-bundle-format.md',
    section: 'reference',
    keywords: ['offline', 'signed', 'digest', 'pinned', 'schema', 'air-gapped'],
  },
  {
    id: 'portable-mock-runtime',
    title: 'Portable mock runtime',
    summary:
      'Serve a mock bundle on a laptop, in CI or inside an air-gapped network with `apiome mock run`.',
    page: 'docs/guide/portable-mock-runtime.md',
    section: 'reference',
    keywords: ['mock server', 'image', 'readiness', 'logs', 'conformance', 'docker'],
  },
  {
    id: 'mock-fixture-packs',
    title: 'Mock fixture packs and data lifecycle',
    summary:
      'Versioned seed data with a stable content digest, and the reset that puts a test back where it started.',
    page: 'docs/guide/mock-fixture-packs.md',
    section: 'reference',
    keywords: ['seed', 'stateful', 'reset', 'session', 'deterministic'],
  },
  {
    id: 'README',
    title: 'User guide index',
    summary: 'Every guide in one table, from importing a spec to querying published ones over MCP.',
    page: 'docs/guide/README.md',
    section: 'reference',
    keywords: ['contents', 'overview', 'all guides', 'documentation', 'spine'],
  },
] as const;

/** How many results the search shows at once. */
export const GUIDE_RESULT_LIMIT = 8;

/**
 * The shortest query that searches.
 *
 * One character matches most of the set, which is a wall of rows rather than an answer; two
 * is the point at which the result list says something.
 */
export const GUIDE_QUERY_MIN_LENGTH = 2;

/** Where a guide is read. */
export function guideHref(entry: GuideEntry): string {
  return buildDocsHref(entry.page);
}

/** What a term matching a given field is worth. Title beats summary beats keyword. */
const FIELD_WEIGHT = { title: 6, summary: 2, keyword: 3 } as const;

/** Extra credit for a term that starts the title — "impo" should reach *Import a spec* first. */
const TITLE_PREFIX_BONUS = 4;

/**
 * Split a query into the terms every result has to satisfy.
 *
 * @param query What the reader typed.
 * @returns Lower-cased, non-empty terms; empty when the query is too short to search.
 */
function queryTerms(query: string): string[] {
  const trimmed = query.trim().toLowerCase();
  if (trimmed.length < GUIDE_QUERY_MIN_LENGTH) return [];
  return trimmed.split(/\s+/).filter(Boolean);
}

/**
 * Score one guide against one term.
 *
 * @param entry The guide.
 * @param term A lower-cased search term.
 * @returns The term's contribution, or `0` when the guide does not match it at all.
 */
function scoreTerm(entry: GuideEntry, term: string): number {
  let score = 0;

  const title = entry.title.toLowerCase();
  if (title.includes(term)) {
    score += FIELD_WEIGHT.title;
    if (title.startsWith(term)) score += TITLE_PREFIX_BONUS;
  }

  if (entry.summary.toLowerCase().includes(term)) score += FIELD_WEIGHT.summary;

  // The id is the file name, so `mcp-quickstart` finds the page a reader saw in a URL.
  if (entry.id.toLowerCase().includes(term)) score += FIELD_WEIGHT.keyword;

  if (entry.keywords.some((keyword) => keyword.toLowerCase().includes(term))) {
    score += FIELD_WEIGHT.keyword;
  }

  return score;
}

/**
 * Search the guide set.
 *
 * Every term has to match something — a second word narrows the result list rather than
 * widening it — and results are ranked by total score, ties broken by the catalog's own
 * order so the same query always returns the same list.
 *
 * @param query What the reader typed. Shorter than {@link GUIDE_QUERY_MIN_LENGTH} returns
 *   nothing, which is how the page knows to show its cards instead of a result list.
 * @param entries The set to search. Defaults to {@link GUIDE_ENTRIES}; a test passes its own.
 * @returns At most {@link GUIDE_RESULT_LIMIT} guides, best match first.
 */
export function searchGuides(
  query: string,
  entries: readonly GuideEntry[] = GUIDE_ENTRIES
): readonly GuideEntry[] {
  const terms = queryTerms(query);
  if (terms.length === 0) return [];

  const scored: Array<{ entry: GuideEntry; score: number; order: number }> = [];

  entries.forEach((entry, order) => {
    let total = 0;
    for (const term of terms) {
      const score = scoreTerm(entry, term);
      // One unmatched term disqualifies the guide: adding a word must never widen the list.
      if (score === 0) return;
      total += score;
    }
    scored.push({ entry, score: total, order });
  });

  return scored
    .sort((a, b) => b.score - a.score || a.order - b.order)
    .slice(0, GUIDE_RESULT_LIMIT)
    .map((result) => result.entry);
}
