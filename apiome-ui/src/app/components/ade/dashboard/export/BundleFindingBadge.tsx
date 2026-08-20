/**
 * BundleFindingBadge — the per-file/-folder finding count chip for the bundle tree and file tabs
 * (MFX-43.2, #4362).
 *
 * Shows a single count with a tone: red when the node holds error-severity findings (validation
 * failures or `error` lint), amber when it holds only advisory ones, nothing when it is clean. The
 * count shown is errors when present (they dominate the tone), else warnings — the same "lead with
 * what blocks" rule the Verify lens badges use.
 */

import type { FileFindingCounts } from './exportBundle';

/**
 * The tone per severity, matched to the Verify lens badges (danger = blocking, warn = advisory).
 *
 * HIVE-8.3 (#5329): the same `data-tone` the lens badge carries, painted by one rule in
 * `globals.css` — so a "3 errors" chip in the bundle tree and a "3" on the validation tab can
 * no longer be two different reds.
 */
const TONE = { error: 'danger', warning: 'warn' } as const;

export interface BundleFindingBadgeProps {
  /** The node's rolled-up error/warning counts. */
  counts: FileFindingCounts;
  /** Optional test id for the chip. */
  testId?: string;
}

/**
 * The finding count chip. Renders null when the node is clean so a clean tree carries no noise.
 *
 * @param props The counts to badge and an optional test id.
 * @returns The toned count chip, or null when there is nothing to flag.
 */
export function BundleFindingBadge({ counts, testId }: BundleFindingBadgeProps) {
  const hasErrors = counts.errors > 0;
  const hasWarnings = counts.warnings > 0;
  if (!hasErrors && !hasWarnings) return null;

  const tone = hasErrors ? 'error' : 'warning';
  const count = hasErrors ? counts.errors : counts.warnings;
  const label = hasErrors
    ? `${counts.errors} error${counts.errors === 1 ? '' : 's'}`
    : `${counts.warnings} warning${counts.warnings === 1 ? '' : 's'}`;

  return (
    <span
      data-testid={testId}
      data-tone={TONE[tone]}
      title={label}
      className="xstd-lens-badge"
    >
      {/* A bare digit in a coloured pill is not a label, and `aria-label` on a plain span is not
          allowed to name it (MFX-41.5) — so the number is decorative and the phrase is the text. */}
      <span aria-hidden>{count}</span>
      <span className="sr-only">{label}</span>
    </span>
  );
}

export default BundleFindingBadge;
