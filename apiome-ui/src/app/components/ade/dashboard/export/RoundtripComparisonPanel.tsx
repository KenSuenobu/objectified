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
import { Badge } from '../../../ui/Badge';
import { Button } from '../../../ui/Button';
import { kindGlyph, kindLabel, kindTone } from './exportFidelityPreview';
import {
  buildRoundtripIssueReport,
  changeKindTone,
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
    <h3 className="xstd-caps">
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
        <div className="xstd-rt__prompt">
          <p className="xstd-quiet">
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
          className="xstd-loading-row"
          data-testid="roundtrip-running"
        >
          <Loader2 className="motion-safe:animate-spin" aria-hidden />
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
          className="xstd-notice" data-tone="warn"
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
              className="xstd-chip"
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
        className="xstd-notice"
        data-tone={presentation.tone === 'rose' ? 'danger' : presentation.tone}
        data-testid={`roundtrip-status-${result.status}`}
      >
        <span className="xstd-notice__grow">
        <p className="font-semibold">
          <span aria-hidden>{presentation.glyph}</span> {presentation.label}
        </p>
        <p className="mt-0.5">{presentation.sentence}</p>
        <p className="mt-0.5" data-testid="roundtrip-summary">
          {summarizeRoundtrip(result)}
        </p>
        </span>
      </div>

      {/* Expected differences — the fidelity report explains each one. */}
      {result.matched.length > 0 && (
        <div data-testid="roundtrip-explained">
          <h4 className="xstd-caps">
            Expected differences · explained by the fidelity report ({result.matched.length})
          </h4>
          <ul className="mt-1 space-y-1">
            {result.matched.map((pair, index) => (
              <li
                key={`${pair.entry.entity}:${pair.entry.key}:${index}`}
                className="xstd-rt__diff"
              >
                <Badge variant={changeKindTone(pair.entry.change)} className="mr-1.5">
                  {changeKindLabel(pair.entry.change)}
                </Badge>
                <span className="xstd-mono text-2xs">
                  {diffEntryLabel(pair.entry)}
                </span>
                <span className="xstd-note ml-2">
                  <Badge variant={kindTone(pair.finding.kind)} className="mr-1">
                    {kindGlyph(pair.finding.kind)} {kindLabel(pair.finding.kind)}
                  </Badge>
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
            <h4 className="xstd-rt__unexplained-title">
              Unexplained differences ({result.unexplained.length + result.overclaims.length})
            </h4>
            {issue && (
              <a
                href={issue.url}
                target="_blank"
                rel="noopener noreferrer"
                className="btn btn--sm"
                data-testid="roundtrip-report-issue"
              >
                <Bug className="h-3.5 w-3.5" aria-hidden />
                Report a fidelity bug
                <ExternalLink className="h-3 w-3" aria-hidden />
              </a>
            )}
          </div>
          <p className="xstd-note mt-0.5">
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
                className="xstd-rt__diff" data-unexplained
              >
                <Badge variant={changeKindTone(entry.change)} className="mr-1.5">
                  {changeKindLabel(entry.change)}
                </Badge>
                <span className="xstd-mono text-2xs">
                  {diffEntryLabel(entry)}
                </span>
              </li>
            ))}
            {result.overclaims.map((item, index) => (
              <li
                key={`overclaim:${item.construct}:${index}`}
                className="xstd-rt__diff" data-unexplained
                data-testid="roundtrip-overclaim"
              >
                <Badge variant="danger" className="mr-1.5">
                  Over-claimed
                </Badge>
                <span className="xstd-mono text-2xs">
                  {item.construct}
                </span>
                <span className="xstd-note ml-2">
                  reported preserved (ok), but it changed or vanished
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}

      {/* Reproduction provenance — the coordinates an issue report (or a matrix cell) shares. */}
      <p
        className="xstd-rt__provenance"
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
