'use client';

/**
 * Shadowed-names alert (CLX-3.4, #4858; re-tokened HIVE-7.7, #5324).
 *
 * Surfaces tool/resource/prompt names exposed by more than one *enabled* endpoint in the tenant's
 * host scope — tool shadowing (OWASP MCP09), where an agent routing by name can be steered to the
 * wrong server. A collision whose endpoints all share a host is flagged strongest (`same_host`); a
 * cross-host collision is advisory.
 *
 * Renders nothing while loading, on error, or when the scope is clean — the catalog should not spend
 * a card on a "no shadowed names" empty state. When collisions exist, a compact bell alert carries
 * the count and expands to the grouped detail list.
 *
 * ### What HIVE-7.7 changed
 *
 * The banner was a hand-built box: `border-red-200 bg-red-50 text-red-900 dark:border-red-800 …`
 * for its two tones, `bg-rose-100 text-rose-800` and `bg-amber-100 text-amber-800` for its two
 * scope chips, and `bg-white/50 dark:bg-black/20` for the rows inside it. It is `ui/Alert` and
 * `ui/Badge` now — the same banner and the same pill every other warning in the product draws —
 * so the tone follows the reader's theme and the two scopes take the tones DESIGN.md §3.1
 * already assigns them (`rose` for the same-host collision, `warn` for the cross-host one).
 *
 * The header stays a `<button>` inside the alert rather than becoming an `actions` slot: the whole
 * strip is the disclosure control, which is what makes the count clickable at a glance.
 */

import * as React from 'react';
import { Bell, ChevronDown } from 'lucide-react';
import { cn } from '@lib/utils';
import { Alert } from '../Alert';
import { Badge } from '../Badge';
import { parseShadowReport, type ShadowReport } from '@/app/utils/mcp-trust-drift';

/**
 * The badge tone each host scope takes.
 *
 * Same-host is the stronger signal and takes `rose`; cross-host is advisory and takes `warn`.
 * Exported because the catalog suite asserts the pairing rather than re-deriving it.
 *
 * @param hostScope The collision's scope, as the report spells it.
 * @returns The `Badge` variant to paint the scope chip with.
 */
export function shadowScopeTone(hostScope: string): 'rose' | 'warn' {
  return hostScope === 'same_host' ? 'rose' : 'warn';
}

/**
 * The alert tone the whole report takes: danger when any collision is same-host, warn otherwise.
 *
 * @param report The parsed shadowing report.
 * @returns The `Alert` variant.
 */
export function shadowAlertTone(report: ShadowReport): 'danger' | 'warn' {
  return report.sameHostCount > 0 ? 'danger' : 'warn';
}

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
    scopeParts.push(`${report.sameHostCount} same-host`);
  }
  if (report.crossHostCount > 0) {
    scopeParts.push(`${report.crossHostCount} cross-host`);
  }
  const detailHint =
    scopeParts.length > 0
      ? `${scopeParts.join(', ')} — duplicate capabilities across enabled endpoints (tool shadowing, OWASP MCP09)`
      : 'Duplicate tool, resource, or prompt names across enabled endpoints';

  return (
    <Alert
      variant={tone}
      icon={null}
      className="mcp-shadow-alert"
      data-testid="mcp-shadowed-names"
    >
      <button
        type="button"
        className="mcp-shadow-alert__summary"
        aria-expanded={expanded}
        onClick={() => setExpanded((open) => !open)}
      >
        <Bell className="mcp-shadow-alert__bell" aria-hidden />
        <span className="mcp-shadow-alert__text">
          <span className="mcp-shadow-alert__count">{countLabel}</span>
          <span className="mcp-shadow-alert__hint">{detailHint}</span>
        </span>
        <ChevronDown
          className={cn('mcp-shadow-alert__chevron', expanded && 'mcp-shadow-alert__chevron--open')}
          aria-hidden
        />
      </button>

      {expanded ? (
        <ul className="mcp-shadow-list">
          {report.groups.map((group) => (
            <li key={`${group.itemType}:${group.name}`} className="mcp-shadow-row">
              <div className="mcp-shadow-row__head">
                <Badge variant={shadowScopeTone(group.hostScope)}>
                  {group.hostScope === 'same_host' ? 'Same host' : 'Cross host'}
                </Badge>
                <span className="mono mcp-shadow-row__name">
                  {group.itemType}:{group.name}
                </span>
                <span className="mcp-shadow-row__meta">
                  exposed by {group.endpointCount} endpoints
                </span>
              </div>
              <p className="mcp-shadow-row__endpoints">
                {group.endpoints
                  .map((endpoint) => endpoint.name || endpoint.slug || endpoint.id)
                  .join(', ')}
              </p>
            </li>
          ))}
        </ul>
      ) : null}
    </Alert>
  );
}

export default ShadowedNamesPanel;
