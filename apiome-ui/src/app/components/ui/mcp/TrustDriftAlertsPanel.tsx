'use client';

/**
 * Trust-drift alerts panel (CLX-3.4, #4858).
 *
 * Diffs an endpoint's current snapshot against its operator-approved trust baseline and shows every
 * material change *classified* — normal change / quality regression / security regression / coverage
 * loss — never a bare "changed" line that would let a regression read as a routine update. The gate
 * chip reflects the baseline's configured risk deltas (and whether blocking is enforced).
 *
 * The panel owns its fetch and its three states: no approved baseline yet (a calm prompt to approve
 * one), up to date (nothing drifted), and drifted (the classified change list + gate). Reading drift
 * never changes anything server-side.
 */

import * as React from 'react';
import { ShieldAlert, ShieldCheck, ShieldQuestion } from 'lucide-react';
import { EmptyState } from '@/app/components/ui/EmptyState';
import { LoadingState } from '@/app/components/ui/LoadingState';
import {
  driftCategoryClass,
  driftCategoryLabel,
  driftGateClass,
  parseDriftReport,
  type DriftReport,
} from '@/app/utils/mcp-trust-drift';

interface Props {
  /** The endpoint whose drift to show. */
  endpointId: string;
}

interface State {
  report: DriftReport | null;
  loading: boolean;
  /** Set when there is no approved baseline (a 404), distinct from a hard error. */
  noBaseline: boolean;
  error: string | null;
}

const CHIP_BASE =
  'inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium tabular-nums';

export function TrustDriftAlertsPanel({ endpointId }: Props) {
  const [state, setState] = React.useState<State>({
    report: null,
    loading: true,
    noBaseline: false,
    error: null,
  });

  React.useEffect(() => {
    let cancelled = false;
    setState({ report: null, loading: true, noBaseline: false, error: null });
    (async () => {
      try {
        const res = await fetch(`/api/mcp/endpoints/${endpointId}/trust-drift`, {
          credentials: 'include',
        });
        if (cancelled) return;
        if (res.status === 404) {
          setState({ report: null, loading: false, noBaseline: true, error: null });
          return;
        }
        if (!res.ok) {
          setState({ report: null, loading: false, noBaseline: false, error: `Request failed (${res.status})` });
          return;
        }
        const payload = await res.json();
        if (cancelled) return;
        setState({ report: parseDriftReport(payload), loading: false, noBaseline: false, error: null });
      } catch {
        if (!cancelled) {
          setState({ report: null, loading: false, noBaseline: false, error: 'Could not load drift.' });
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [endpointId]);

  if (state.loading) {
    return <LoadingState message="Diffing against the approved baseline…" />;
  }
  if (state.noBaseline) {
    return (
      <EmptyState
        icon={<ShieldQuestion className="h-8 w-8 text-fg-on-accent" aria-hidden />}
        title="No approved baseline yet"
        description="Approve a trust baseline for this endpoint to start catching drift, shadowing, and trust regressions against what you blessed."
      />
    );
  }
  if (state.error || !state.report) {
    return (
      <EmptyState
        icon={<ShieldAlert className="h-8 w-8 text-fg-on-accent" aria-hidden />}
        title="Drift unavailable"
        description={state.error ?? 'The drift report could not be loaded.'}
      />
    );
  }

  const report = state.report;
  if (report.unchanged || report.changes.length === 0) {
    return (
      <EmptyState
        icon={<ShieldCheck className="h-8 w-8 text-fg-on-accent" aria-hidden />}
        title="No drift from the approved baseline"
        description="Nothing trust-relevant has moved since this endpoint's baseline was approved."
      />
    );
  }

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <span className={`${CHIP_BASE} ${driftGateClass(report.gate.status)}`}>
          Gate: {report.gate.status}
          {report.gate.enforced ? ' (enforced)' : ' (advisory)'}
        </span>
        {(['security_regression', 'coverage_loss', 'quality_regression', 'normal_change'] as const).map(
          (category) => {
            const count = report.categoryCounts[category] ?? 0;
            if (count <= 0) return null;
            return (
              <span key={category} className={`${CHIP_BASE} ${driftCategoryClass(category)}`}>
                {driftCategoryLabel(category)}: {count}
              </span>
            );
          },
        )}
      </div>
      <ul className="space-y-2">
        {report.changes.map((change, index) => (
          <li
            key={`${change.component}:${change.path}:${index}`}
            className="rounded-md p-2 shadow-[inset_0_0_0_1px_var(--border)]"
          >
            <div className="flex flex-wrap items-center gap-2">
              <span className={`${CHIP_BASE} ${driftCategoryClass(change.category)}`}>
                {driftCategoryLabel(change.category)}
              </span>
              <span className="font-mono text-xs text-fg-muted">
                {change.component}:{change.path}
              </span>
            </div>
            <p className="mt-1 text-sm text-fg">{change.summary}</p>
          </li>
        ))}
      </ul>
    </div>
  );
}

export default TrustDriftAlertsPanel;
