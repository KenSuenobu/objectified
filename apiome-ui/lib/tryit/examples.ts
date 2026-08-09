/**
 * Request-body example collection and editor formatting — SIM-3.4 (#4450), promoted by DWX-4.7
 * (private-suite#2696).
 *
 * It moved from `apiome-browse/lib/tryit/examples.ts` with the snippet renderer beside it. The rule
 * both applications now share is the one that matters: **a prefilled value comes from the document
 * or the field stays empty.** {@link collectBodyExamples} reads the OpenAPI order — the named
 * `examples` map first, then a lone media-level `example` — and yields nothing when a variant
 * declares neither, so a request builder cannot open with a plausible-looking payload its author
 * never wrote. Browse imports it through a re-export, so its own suite still covers it.
 */

import type { BodyVariant, ParamSpec } from './operation';
import { paramKey } from './operation';

/** One selectable named request example for a content-type variant. */
export interface NamedBodyExample {
  /** Example key from the OpenAPI `examples` map, or `example` for a single media example. */
  name: string;
  summary?: string;
  value: unknown;
}

/** Tracks where the current editor body text came from. */
export type BodySource =
  | { kind: 'example'; name: string }
  | { kind: 'generated'; seed: number }
  | { kind: 'manual' }
  | { kind: 'empty' };

/** Extract the payload from an OpenAPI example entry (`{ value }` wrapper or bare value). */
export function resolveExampleValue(entry: unknown): unknown {
  if (entry != null && typeof entry === 'object' && !Array.isArray(entry) && 'value' in entry) {
    return (entry as { value: unknown }).value;
  }
  return entry;
}

/**
 * Collect selectable request examples for one body variant.
 *
 * OpenAPI order: named `examples` map first, then a lone media-level `example`.
 */
export function collectBodyExamples(variant: BodyVariant): NamedBodyExample[] {
  const out: NamedBodyExample[] = [];
  if (variant.examples) {
    for (const [name, entry] of Object.entries(variant.examples)) {
      out.push({
        name,
        summary: entry.summary,
        value: entry.value,
      });
    }
  }
  if (variant.example !== undefined) {
    out.push({ name: 'example', value: variant.example });
  }
  return out;
}

/** True when the panel can offer example selection or schema synthesis for this variant. */
export function bodyVariantHasPrefillSupport(variant: BodyVariant): boolean {
  return collectBodyExamples(variant).length > 0 || variant.schema != null;
}

/** Serialize a resolved example value for the Monaco body editor. */
export function formatBodyForEditor(value: unknown, isJson: boolean): string {
  if (value === undefined || value === null) return '';
  if (isJson) {
    if (typeof value === 'string') {
      try {
        JSON.parse(value);
        return value;
      } catch {
        return JSON.stringify(value, null, 2);
      }
    }
    return JSON.stringify(value, null, 2);
  }
  if (typeof value === 'string') return value;
  return String(value);
}

/** Human-readable label for the body source indicator. */
export function describeBodySource(source: BodySource): string | null {
  switch (source.kind) {
    case 'example':
      return source.name === 'example' ? 'Example' : `Example: ${source.name}`;
    case 'generated':
      return `Generated (seed ${source.seed})`;
    case 'manual':
      return 'Edited manually';
    case 'empty':
      return null;
  }
}

/** Build initial parameter form values from defaults and param-level examples. */
export function buildInitialParamValues(params: ParamSpec[]): Record<string, string> {
  const initial: Record<string, string> = {};
  for (const param of params) {
    const value = resolveParamPrefill(param);
    if (value != null) initial[paramKey(param)] = String(value);
  }
  return initial;
}

function resolveParamPrefill(param: ParamSpec): unknown {
  const { schema } = param;
  if (schema.default !== undefined) return schema.default;
  if (schema.example !== undefined) return schema.example;
  if (schema.examples) {
    const first = Object.values(schema.examples)[0];
    return resolveExampleValue(first);
  }
  return undefined;
}
