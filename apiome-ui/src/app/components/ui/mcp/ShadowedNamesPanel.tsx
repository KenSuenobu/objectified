'use client';

/**
 * Shadowed-names alert (CLX-3.4, #4858).
 *
 * Surfaces tool/resource/prompt names exposed by more than one *enabled* endpoint in the tenant's
 * host scope — tool shadowing (OWASP MCP09), where an agent routing by name can be steered to the
 * wrong server. A collision whose endpoints all share a host is flagged strongest (`same_host`); a
 * cross-host collision is advisory.
 *
 * Renders nothing while loading, on error, or when the scope is clean — the catalog should not spend
 * a card on a "no shadowed names" empty state. When collisions exist, a compact bell alert carries
 * the count and expands to the grouped detail list.
 */

import * as React from 'react';
import { Bell, ChevronDown } from 'lucide-react';
import { cn } from '@lib/utils';
import { parseShadowReport, type ShadowReport } from '@/app/utils/mcp-trust-drift';

const CHIP_BASE =
  'inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium';

/** CSS classes for the host-scope chip (same-host is the stronger signal). */
export function shadowScopeClass(hostScope: string): string {
  return hostScope === 'same_host'
    ? 'bg-rose-100 text-rose-800 dark:bg-rose-900/40 dark:text-rose-300'
    : 'bg-amber-100 text-amber-800 dark:bg-amber-900/40 dark:text-amber-300';
}

function shadowAlertTone(report: ShadowReport): 'error' | 'warning' {
  return report.sameHostCount > 0 ? 'error' : 'warning';
}

const TONE_CLASS: Record<'error' | 'warning', string> = {
  error:
    'border-red-200 bg-red-50 text-red-900 dark:border-red-800 dark:bg-red-900/20 dark:text-red-100',
  warning:
    'border-amber-200 bg-amber-50 text-amber-900 dark:border-amber-800 dark:bg-amber-900/20 dark:text-amber-100',
};

const TONE_ICON_CLASS: Record<'error' | 'warning', string> = {
  error: 'text-red-600 dark:text-red-400',
  warning: 'text-amber-600 dark:text-amber-400',
};

export function ShadowedNamesPanel() {
  const [report, setReport] = React.useState<ShadowReport | null>(null);
  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState<string | null>(null);
  const [expanded, setExpanded] = React.useState(false);

  React.useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch('/api/mcp/data-quality/shadowing', { credentials: 'include' });
        if (cancelled) return;
        if (!res.ok) {
          setError(`Request failed (${res.status})`);
          setLoading(false);
          return;
        }
        const payload = await res.json();
        if (cancelled) return;
        setReport(parseShadowReport(payload));
        setLoading(false);
      } catch {
        if (!cancelled) {
          setError('Could not load shadowing report.');
          setLoading(false);
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // Clean / loading / unavailable: take no catalog real estate.
  if (loading || error || !report || report.groupCount === 0) {
    return null;
  }

  const tone = shadowAlertTone(report);
  const countLabel =
    report.groupCount === 1 ? '1 shadowed name' : `${report.groupCount} shadowed names`;
  const scopeParts: string[] = [];
  if (report.sameHostCount > 0) {
    scopeParts.push(
      `${report.sameHostCount} same-host`,
    );
  }
  if (report.crossHostCount > 0) {
    scopeParts.push(
      `${report.crossHostCount} cross-host`,
    );
  }
  const detailHint =
    scopeParts.length > 0
      ? `${scopeParts.join(', ')} — duplicate capabilities across enabled endpoints`
      : 'Duplicate tool, resource, or prompt names across enabled endpoints';

  return (
    <div
      role="alert"
      className={cn('rounded-lg border', TONE_CLASS[tone])}
    >
      <button
        type="button"
        className="flex w-full items-start gap-2.5 px-3 py-2.5 text-left transition-colors hover:bg-black/5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-current dark:hover:bg-white/5"
        aria-expanded={expanded}
        onClick={() => setExpanded((open) => !open)}
      >
        <Bell className={cn('mt-0.5 h-4 w-4 shrink-0', TONE_ICON_CLASS[tone])} aria-hidden />
        <span className="min-w-0 flex-1">
          <span className="block text-sm font-medium leading-snug">{countLabel}</span>
          <span className="mt-0.5 block text-xs opacity-80">{detailHint}</span>
        </span>
        <ChevronDown
          className={cn(
            'mt-0.5 h-4 w-4 shrink-0 opacity-70 transition-transform',
            expanded && 'rotate-180',
          )}
          aria-hidden
        />
      </button>

      {expanded ? (
        <ul className="space-y-2 border-t border-current/10 px-3 py-2.5">
          {report.groups.map((group) => (
            <li
              key={`${group.itemType}:${group.name}`}
              className="rounded-md border border-current/15 bg-white/50 p-2 dark:bg-black/20"
            >
              <div className="flex flex-wrap items-center gap-2">
                <span className={`${CHIP_BASE} ${shadowScopeClass(group.hostScope)}`}>
                  {group.hostScope === 'same_host' ? 'Same host' : 'Cross host'}
                </span>
                <span className="font-mono text-xs">
                  {group.itemType}:{group.name}
                </span>
                <span className="text-xs opacity-70">
                  exposed by {group.endpointCount} endpoints
                </span>
              </div>
              <p className="mt-1 text-xs opacity-80">
                {group.endpoints
                  .map((endpoint) => endpoint.name || endpoint.slug || endpoint.id)
                  .join(', ')}
              </p>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

export default ShadowedNamesPanel;
