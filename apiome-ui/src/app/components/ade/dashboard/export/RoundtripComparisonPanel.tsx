'use client';

/**
 * RoundtripComparisonPanel — export → re-import → diff evidence (IXH-4.4, #5112).
 *
 * The fidelity report *predicts* what an export loses; the strongest possible check of that
 * claim is empirical: emit the artifact, re-import it through the matching adapter, and diff
 * the result against the source. The IXH-1.7 conformance matrix does this in CI over the
 * corpus; this panel runs the same loop for the user's own document, **on demand**:
 *
 *  - the action is **explicit and bounded** — a real emit plus a real re-import runs only
 *    when the user clicks "Run round-trip check", never implicitly on a preview or render;
 *  - differences come back **grouped**: those the fidelity report explains are listed as
 *    expected loss (each paired with its finding), while unexplained differences and
 *    over-claimed preservation are flagged as a fidelity bug;
 *  - unexplained differences offer a **one-click issue report** — a prefilled GitHub issue
 *    carrying the reproduction coordinates (never source content; credential-shaped option
 *    keys are stripped);
 *  - a target with **no import adapter** states why the comparison was skipped
 *    (`status: unsupported`, the matrix's own explanation) instead of hiding the action.
 *
 * Verdicts are stated in words + glyph before colour (the Studio's house rule), and a
 * transport failure degrades to a quiet notice that never gates the export.
 */

import { AlertTriangle, Bug, ExternalLink, Loader2, RefreshCcw, Repeat2 } from 'lucide-react';
import { cn } from '@lib/utils';
import { Button } from '../../../ui/Button';
import { kindBadgeClass, kindGlyph, kindLabel } from './exportFidelityPreview';
import {
  buildRoundtripIssueReport,
  changeKindBadgeClass,
  changeKindLabel,
  diffEntryLabel,
  roundtripStatusPresentation,
  summarizeRoundtrip,
  type ExportRoundtripResponse,
} from './exportRoundtrip';

export interface RoundtripComparisonPanelProps {
  /** The settled round-trip result for the current configuration, or null. */
  result: ExportRoundtripResponse | null;
  /** Whether a round trip is in flight. */
  running: boolean;
  /** Whether a round trip has settled for the current configuration. */
  hasRun: boolean;
  /** The failure message from a failed run, or null. */
  error: string | null;
  /** Whether the displayed result was restored from the session cache. */
  fromCache: boolean;
  /** Run (or re-run, with `force`) the round trip — the panel's only side effect. */
  onRun: (force?: boolean) => void;
  /** Human label of the chosen target format (e.g. `OpenAPI 3.1`). */
  targetLabel: string;
  /** The non-default option overrides of the current configuration (for the issue report). */
  options?: Record<string, unknown> | null;
  className?: string;
}

/** The panel's heading — one look for every state. */
function SectionHeading({ targetLabel }: { targetLabel: string }) {
  return (
    <h3 className="flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-gray-500 dark:text-gray-400">
      <Repeat2 className="h-3.5 w-3.5" aria-hidden />
      Round-trip comparison — {targetLabel}
    </h3>
  );
}

export function RoundtripComparisonPanel({
  result,
  running,
  hasRun,
  error,
  fromCache,
  onRun,
  targetLabel,
  options = null,
  className,
}: RoundtripComparisonPanelProps) {
  // Unrun (and not running): the explicit, bounded entry point. The explanation states the
  // cost so the user knows why this is a button and not an ambient preview.
  if (!hasRun && !running) {
    return (
      <section className={cn('space-y-2', className)} data-testid="roundtrip-panel">
        <SectionHeading targetLabel={targetLabel} />
        <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-gray-200 px-3 py-2.5 dark:border-gray-700">
          <p className="text-xs text-gray-600 dark:text-gray-300">
            Check the fidelity report against reality: emit this artifact, re-import it, and
            diff the result against the source. Runs one real emit + re-import, only when you
            ask.
          </p>
          <Button size="sm" variant="outline" onClick={() => onRun()} data-testid="roundtrip-run">
            <Repeat2 className="h-3.5 w-3.5" aria-hidden />
            Run round-trip check
          </Button>
        </div>
      </section>
    );
  }

  if (running) {
    return (
      <section className={cn('space-y-2', className)} data-testid="roundtrip-panel">
        <SectionHeading targetLabel={targetLabel} />
        <p
          className="flex items-center gap-2 text-xs text-gray-600 dark:text-gray-300"
          data-testid="roundtrip-running"
        >
          <Loader2 className="h-3.5 w-3.5 animate-spin text-indigo-500" aria-hidden />
          Emitting, re-importing, and comparing against the source…
        </p>
      </section>
    );
  }

  // A failed *request* (transport / server error) — distinct from a failing comparison. It
  // never gates the export; the user can retry.
  if (error || !result) {
    return (
      <section className={cn('space-y-2', className)} data-testid="roundtrip-panel">
        <SectionHeading targetLabel={targetLabel} />
        <div
          className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-amber-300 bg-amber-50 px-3 py-2 text-xs text-amber-900 dark:border-amber-800 dark:bg-amber-950/30 dark:text-amber-200"
          data-testid="roundtrip-error"
        >
          <span>
            <AlertTriangle className="mr-1.5 inline h-3.5 w-3.5 align-text-bottom" aria-hidden />
            The round-trip comparison could not run — the artifact and its fidelity report are
            unaffected. {error ?? 'No result was returned.'}
          </span>
          <Button size="sm" variant="outline" onClick={() => onRun(true)} data-testid="roundtrip-retry">
            <RefreshCcw className="h-3.5 w-3.5" aria-hidden />
            Retry
          </Button>
        </div>
      </section>
    );
  }

  const presentation = roundtripStatusPresentation(result);
  const failing = result.status !== 'pass' && result.status !== 'unsupported';
  const issue = failing
    ? buildRoundtripIssueReport({ response: result, targetLabel, options })
    : null;

  return (
    <section className={cn('space-y-3', className)} data-testid="roundtrip-panel">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <SectionHeading targetLabel={targetLabel} />
        <div className="flex items-center gap-2">
          {fromCache && (
            <span
              className="rounded-full bg-gray-100 px-2 py-0.5 text-2xs text-gray-600 dark:bg-gray-800 dark:text-gray-300"
              data-testid="roundtrip-from-cache"
            >
              restored from this session
            </span>
          )}
          <Button size="sm" variant="ghost" onClick={() => onRun(true)} data-testid="roundtrip-rerun">
            <RefreshCcw className="h-3.5 w-3.5" aria-hidden />
            Re-run
          </Button>
        </div>
      </div>

      {/* The verdict: label + glyph + sentence, colour last. */}
      <div
        role="status"
        aria-live="polite"
        className={cn('rounded-lg border px-3 py-2.5 text-xs', presentation.bannerClass)}
        data-testid={`roundtrip-status-${result.status}`}
      >
        <p className="font-semibold">
          <span aria-hidden>{presentation.glyph}</span> {presentation.label}
        </p>
        <p className="mt-0.5">{presentation.sentence}</p>
        <p className="mt-0.5" data-testid="roundtrip-summary">
          {summarizeRoundtrip(result)}
        </p>
      </div>

      {/* Expected differences — the fidelity report explains each one. */}
      {result.matched.length > 0 && (
        <div data-testid="roundtrip-explained">
          <h4 className="text-2xs font-semibold uppercase tracking-wide text-gray-500 dark:text-gray-400">
            Expected differences · explained by the fidelity report ({result.matched.length})
          </h4>
          <ul className="mt-1 space-y-1">
            {result.matched.map((pair, index) => (
              <li
                key={`${pair.entry.entity}:${pair.entry.key}:${index}`}
                className="rounded-md border border-gray-200 px-2.5 py-1.5 text-xs dark:border-gray-700"
              >
                <span
                  className={cn(
                    'mr-1.5 rounded-full px-1.5 py-0.5 text-2xs font-medium',
                    changeKindBadgeClass(pair.entry.change),
                  )}
                >
                  {changeKindLabel(pair.entry.change)}
                </span>
                <span className="font-mono text-2xs text-gray-700 dark:text-gray-200">
                  {diffEntryLabel(pair.entry)}
                </span>
                <span className="ml-2 text-gray-500 dark:text-gray-400">
                  <span
                    className={cn(
                      'mr-1 rounded-full px-1.5 py-0.5 text-2xs font-medium',
                      kindBadgeClass(pair.finding.kind),
                    )}
                  >
                    {kindGlyph(pair.finding.kind)} {kindLabel(pair.finding.kind)}
                  </span>
                  {pair.finding.message}
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}

      {/* Unexplained differences — a fidelity bug worth reporting, with the one-click path. */}
      {(result.unexplained.length > 0 || result.overclaims.length > 0) && (
        <div data-testid="roundtrip-unexplained">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h4 className="text-2xs font-semibold uppercase tracking-wide text-red-700 dark:text-red-300">
              Unexplained differences ({result.unexplained.length + result.overclaims.length})
            </h4>
            {issue && (
              <a
                href={issue.url}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-1 rounded-md border border-slate-300 bg-white px-2.5 py-1 text-xs font-medium text-slate-700 shadow-sm hover:bg-slate-50 dark:border-slate-600 dark:bg-slate-800 dark:text-slate-200 dark:hover:bg-slate-700"
                data-testid="roundtrip-report-issue"
              >
                <Bug className="h-3.5 w-3.5" aria-hidden />
                Report a fidelity bug
                <ExternalLink className="h-3 w-3" aria-hidden />
              </a>
            )}
          </div>
          <p className="mt-0.5 text-2xs text-gray-500 dark:text-gray-400">
            The fidelity report does not account for these. The report link carries only
            reproduction coordinates
            {issue && issue.redactedOptionKeys.length > 0
              ? ` (credential-shaped options withheld: ${issue.redactedOptionKeys.join(', ')})`
              : ''}
            — never your API content.
          </p>
          <ul className="mt-1 space-y-1">
            {result.unexplained.map((entry, index) => (
              <li
                key={`${entry.entity}:${entry.key}:${index}`}
                className="rounded-md border border-red-200 px-2.5 py-1.5 text-xs dark:border-red-900/60"
              >
                <span
                  className={cn(
                    'mr-1.5 rounded-full px-1.5 py-0.5 text-2xs font-medium',
                    changeKindBadgeClass(entry.change),
                  )}
                >
                  {changeKindLabel(entry.change)}
                </span>
                <span className="font-mono text-2xs text-gray-700 dark:text-gray-200">
                  {diffEntryLabel(entry)}
                </span>
              </li>
            ))}
            {result.overclaims.map((item, index) => (
              <li
                key={`overclaim:${item.construct}:${index}`}
                className="rounded-md border border-red-200 px-2.5 py-1.5 text-xs dark:border-red-900/60"
                data-testid="roundtrip-overclaim"
              >
                <span className="mr-1.5 rounded-full bg-red-100 px-1.5 py-0.5 text-2xs font-medium text-red-800 dark:bg-red-900/40 dark:text-red-200">
                  Over-claimed
                </span>
                <span className="font-mono text-2xs text-gray-700 dark:text-gray-200">
                  {item.construct}
                </span>
                <span className="ml-2 text-gray-500 dark:text-gray-400">
                  reported preserved (ok), but it changed or vanished
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}

      {/* Reproduction provenance — the coordinates an issue report (or a matrix cell) shares. */}
      <p
        className="font-mono text-2xs text-gray-400 dark:text-gray-500"
        data-testid="roundtrip-provenance"
      >
        source {result.source_fingerprint.slice(0, 12)}
        {result.reimported_fingerprint
          ? ` · re-import ${result.reimported_fingerprint.slice(0, 12)}`
          : ''}
        {result.adapter_key ? ` · adapter ${result.adapter_key}` : ''} · apiome{' '}
        {result.apiome_version}
      </p>
    </section>
  );
}
