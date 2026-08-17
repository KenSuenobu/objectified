/**
 * Client fetch + lookup for the GOV-1.2 built-in lint rule catalog (`GET /v1/lint/rules`).
 *
 * Violation surfaces (GOV-2.4) use this registry to attach each finding's stable `rule` id to its
 * one-line rationale and docs anchor. The catalog is identical for every tenant; style guides only
 * override enablement and severity at lint time.
 */

import YAML from 'yaml';

import { buildDocsHref } from './docsLinks';

export interface LintRuleCatalogEntry {
  ruleId: string;
  pack: string;
  category: string;
  defaultSeverity: string;
  rationale: string;
  docsAnchor: string;
}

export interface LintRuleCatalog {
  rules: LintRuleCatalogEntry[];
  count: number;
  docsPage: string;
}

/** Default docs page path returned by the REST catalog (GOV-1.2). */
export const DEFAULT_LINT_RULES_DOCS_PAGE = 'docs/guide/lint-rules.md';

/** Build an external "View rule" href from the catalog's docs page + per-rule anchor. */
export function buildLintRuleDocsHref(docsPage: string, docsAnchor: string): string {
  return buildDocsHref(docsPage || DEFAULT_LINT_RULES_DOCS_PAGE, docsAnchor);
}

function parseCatalogEntry(raw: unknown): LintRuleCatalogEntry | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const ruleId = typeof r.ruleId === 'string' ? r.ruleId : '';
  if (!ruleId) return null;
  return {
    ruleId,
    pack: typeof r.pack === 'string' ? r.pack : '',
    category: typeof r.category === 'string' ? r.category : '',
    defaultSeverity: typeof r.defaultSeverity === 'string' ? r.defaultSeverity : 'warning',
    rationale: typeof r.rationale === 'string' ? r.rationale : '',
    docsAnchor: typeof r.docsAnchor === 'string' ? r.docsAnchor : ruleId.replace(/\./g, '-'),
  };
}

/** Parse a catalog payload defensively (proxy may wrap in `{ success, data }`). */
export function lintRuleCatalogFromPayload(data: unknown): LintRuleCatalog | null {
  const root =
    data && typeof data === 'object' && 'data' in (data as object)
      ? (data as { data: unknown }).data
      : data;
  if (!root || typeof root !== 'object') return null;
  const r = root as Record<string, unknown>;
  const rules = (Array.isArray(r.rules) ? r.rules : [])
    .map(parseCatalogEntry)
    .filter((entry): entry is LintRuleCatalogEntry => entry != null);
  return {
    rules,
    count: typeof r.count === 'number' ? r.count : rules.length,
    docsPage:
      typeof r.docsPage === 'string' && r.docsPage.trim()
        ? r.docsPage.trim()
        : DEFAULT_LINT_RULES_DOCS_PAGE,
  };
}

/** Fetch the built-in rule catalog via the Next.js proxy. */
export async function fetchLintRuleCatalog(options?: { signal?: AbortSignal }): Promise<LintRuleCatalog> {
  const response = await fetch('/api/lint/rules', { method: 'GET', signal: options?.signal });
  const data = await response.json().catch(() => null);
  if (!response.ok || !data) {
    const message =
      (data && (data.error || data.detail)) || `Failed to load lint rule catalog (HTTP ${response.status})`;
    throw new Error(typeof message === 'string' ? message : 'Failed to load lint rule catalog');
  }
  const catalog = lintRuleCatalogFromPayload(data);
  if (!catalog) throw new Error('Malformed lint rule catalog response');
  return catalog;
}

/** Build a rule-id → catalog entry map for O(1) enrichment lookups. */
export function lintRuleCatalogLookup(catalog: LintRuleCatalog): Map<string, LintRuleCatalogEntry> {
  return new Map(catalog.rules.map((rule) => [rule.ruleId, rule]));
}

/**
 * Extract `rules.<id>.description` strings from a custom-rules YAML document (GOV-1.3).
 * Used as the rationale for custom-rule violations when the built-in catalog has no entry.
 */
export function customRuleDescriptionsFromYaml(yamlText: string): Map<string, string> {
  const out = new Map<string, string>();
  const trimmed = (yamlText || '').trim();
  if (!trimmed) return out;
  try {
    const doc = YAML.parse(trimmed) as { rules?: Record<string, { description?: string }> };
    const rules = doc?.rules;
    if (!rules || typeof rules !== 'object') return out;
    for (const [ruleId, def] of Object.entries(rules)) {
      const description = def?.description;
      if (typeof description === 'string' && description.trim()) {
        out.set(ruleId, description.trim());
      }
    }
  } catch {
    /* malformed draft — callers fall back to the finding message */
  }
  return out;
}
