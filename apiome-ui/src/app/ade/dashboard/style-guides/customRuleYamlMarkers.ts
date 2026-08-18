/**
 * Map GOV-1.3 validation pointers onto Monaco marker ranges in a YAML document.
 *
 * Server 422 responses carry `detail.pointer` values such as
 * `rules.my-rule.then.functionOptions.match`; this module resolves them to line/column
 * spans for inline squiggles in the custom-rules editor.
 */

export interface YamlPointerRange {
  startLine: number;
  startColumn: number;
  endLine: number;
  endColumn: number;
}

/** Escape a string for use inside a RegExp character class alternative. */
function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Resolve a dotted validation pointer to a single-line range in `yaml`.
 *
 * Walks pointer segments from the end until a `key:` line is found.
 */
export function pointerToYamlRange(pointer: string, yaml: string): YamlPointerRange {
  const lines = yaml.split('\n');
  const parts = pointer.split('.').filter(Boolean);
  if (parts.length === 0) {
    return { startLine: 1, startColumn: 1, endLine: 1, endColumn: Math.max(1, lines[0]?.length ?? 1) };
  }

  for (let pi = parts.length - 1; pi >= 0; pi--) {
    const key = parts[pi];
    const re = new RegExp(`^(\\s*)${escapeRegExp(key)}\\s*:`);
    for (let i = 0; i < lines.length; i++) {
      const match = lines[i].match(re);
      if (match) {
        const startColumn = (match[1]?.length ?? 0) + 1;
        const endColumn = Math.max(startColumn + 1, lines[i].length + 1);
        return { startLine: i + 1, startColumn, endLine: i + 1, endColumn };
      }
    }
  }

  const fallbackEnd = Math.max(1, (lines[0]?.length ?? 0) + 1);
  return { startLine: 1, startColumn: 1, endLine: 1, endColumn: fallbackEnd };
}

/** Monaco `MarkerSeverity` numerics — avoid importing `monaco-editor` in shared helpers. */
export const YAML_ERROR_MARKER_SEVERITY = 8;

export interface ServerValidationDetail {
  message?: string;
  pointer?: string;
}

/** Normalize a style-guides proxy error into pointer + message when present. */
export function parseValidationDetail(error: unknown): ServerValidationDetail | null {
  if (!error || typeof error !== 'object') return null;
  const obj = error as Record<string, unknown>;
  const detail = obj.detail ?? obj.error ?? obj;
  if (!detail || typeof detail !== 'object') return null;
  const d = detail as Record<string, unknown>;
  if (typeof d.message === 'string') {
    return { message: d.message, pointer: typeof d.pointer === 'string' ? d.pointer : '' };
  }
  return null;
}

// ---------------------------------------------------------------------------------------
// Dry-run findings as markers (HIVE-5.7, #5310)
// ---------------------------------------------------------------------------------------

/**
 * Monaco's `MarkerSeverity`, by the severity string the linter speaks.
 *
 * The numerics rather than the enum for the reason {@link YAML_ERROR_MARKER_SEVERITY}
 * gives: this module is imported by pure unit tests and by the page's model, neither of
 * which should pull `monaco-editor` into their bundle to read four constants.
 */
export const MARKER_SEVERITY: Readonly<Record<'error' | 'warning' | 'info', number>> = {
  error: 8,
  warning: 4,
  info: 2,
};

/** A marker, in the shape `monaco.editor.setModelMarkers` takes. */
export interface YamlMarker extends YamlPointerRange {
  /** Monaco's numeric severity. */
  severity: number;
  /** The sentence shown in the hover and the problems list. */
  message: string;
  /** The rule the marker came from, shown after the message as Monaco's `source`. */
  source: string;
}

/** One dry-run violation, reduced to what a marker needs. */
export interface MarkerFinding {
  /** The custom rule that fired. */
  rule: string;
  /** How badly. */
  severity: 'error' | 'warning' | 'info';
  /** What it says. */
  message: string;
  /** Where in the *document under test* — carried into the marker so the two can be paired. */
  path?: string;
}

/**
 * Map a dry run's results onto marker ranges in the draft YAML.
 *
 * This is the acceptance criterion "dry-run results map back to editor markers", and the
 * mapping it makes is worth being explicit about, because there are two documents in play.
 * A finding's `path` points into the **spec that was linted** (`paths./refunds.post…`),
 * which is not open in this editor and has no line here. What the reader needs to see is
 * *which rule they just wrote* produced it — so the marker is placed on that rule's own
 * declaration, `rules.<ruleId>`, and the spec path travels in the message.
 *
 * A rule that aborted (`ruleErrors`) is always an error marker: it did not merely fail the
 * document, it failed to run at all, and that is a defect in the YAML rather than in the
 * spec.
 *
 * @param findings The violations the dry run reported.
 * @param ruleErrors Rules that aborted during evaluation, by rule id.
 * @param yaml The draft the editor is showing.
 * @returns One marker per finding and per aborted rule, in that order.
 */
export function previewMarkers(
  findings: readonly MarkerFinding[],
  ruleErrors: Readonly<Record<string, string>>,
  yaml: string,
): YamlMarker[] {
  const markers: YamlMarker[] = [];

  for (const finding of findings) {
    markers.push({
      ...pointerToYamlRange(`rules.${finding.rule}`, yaml),
      severity: MARKER_SEVERITY[finding.severity] ?? MARKER_SEVERITY.info,
      message: finding.path ? `${finding.message} (${finding.path})` : finding.message,
      source: finding.rule,
    });
  }

  for (const [ruleId, reason] of Object.entries(ruleErrors)) {
    markers.push({
      ...pointerToYamlRange(`rules.${ruleId}`, yaml),
      severity: MARKER_SEVERITY.error,
      message: `Rule aborted during evaluation — ${reason}`,
      source: ruleId,
    });
  }

  return markers;
}
