'use client';

/**
 * Tenant MCP policy change history — MTG-5.2 (#4786), redrawn as a drawer section by
 * HIVE-5.1 (#5304).
 *
 * Authority: `docs/mockups/workspace/tenants.html` `[data-tab-panel="m-history"]`.
 *
 * Loads newest-first audit rows from `/api/tenants/mcp-policy/history` and expands a row to
 * show the before/after of the policy fields and of each tool flag.
 *
 * ### What HIVE-5.1 changed
 *
 * The section no longer collapses itself — the "Policy history" tab is the disclosure, so
 * mounting is the request to load, and Refresh is always reachable instead of appearing only
 * once the old header was expanded. The diff rows are now the mockup's `.diff-line`: the old
 * value struck through in the danger ink, an arrow, the new value in the ok ink, both
 * monospaced. That is a real gain in readability over two grey strings separated by a `→`,
 * and it costs nothing but tokens.
 */

import { useCallback, useEffect, useState } from 'react';
import { ArrowRight, ChevronDown, ChevronRight, RefreshCw } from 'lucide-react';
import { Alert } from '@/app/components/ui/Alert';
import { Avatar } from '@/app/components/ui/Avatar';
import { Button } from '@/app/components/ui/Button';
import { LoadingState } from '@/app/components/ui/LoadingState';
import { Spinner } from '@/app/components/ui/Spinner';
import {
  fetchMcpPolicyHistory,
  type TenantMcpPolicyChangeEntry,
} from './mcpPolicyApi';
import {
  diffMcpPolicySnapshots,
  formatToolFlagValue,
  type McpPolicySnapshotDiff,
} from './mcpPolicyHistoryDiff';

export interface TenantMcpPolicyHistoryProps {
  /** Bumped after a successful policy save so the list refreshes. */
  reloadToken?: number;
}

/** How many entries the audit trail shows. */
const HISTORY_LIMIT = 50;

function formatWhen(value: string): string {
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return value;
  return d.toLocaleString('en-US', {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

/** One `field: before → after` line, in the mockup's struck-through / ok-ink pair. */
function DiffLine({ field, before, after }: { field: string; before: string; after: string }) {
  return (
    <div className="tnt-diff-line">
      <span className="tnt-diff-line__field">{field}</span>
      <span className="tnt-diff-line__from">{before}</span>
      <ArrowRight className="size-[var(--icon-button)] shrink-0 text-fg-subtle" aria-hidden />
      <span className="tnt-diff-line__to">{after}</span>
    </div>
  );
}

function ChangeDetail({ diff }: { diff: McpPolicySnapshotDiff }) {
  if (diff.topLevel.length === 0 && diff.tools.length === 0) {
    return (
      <p className="tnt-hist-diff text-xs text-fg-muted">
        No field-level differences in this snapshot pair.
      </p>
    );
  }

  return (
    <div className="tnt-hist-diff">
      {diff.topLevel.length > 0 && (
        <div>
          <p className="tnt-caps mb-1">Settings changes</p>
          {diff.topLevel.map((change) => (
            <DiffLine
              key={change.field}
              field={change.label}
              before={change.before}
              after={change.after}
            />
          ))}
        </div>
      )}

      {diff.tools.length > 0 && (
        <div className={diff.topLevel.length > 0 ? 'mt-2' : undefined}>
          <p className="tnt-caps mb-1">Tool-flag changes</p>
          {diff.tools.map((change) => (
            <DiffLine
              key={`${change.tool_id}:${change.flag}`}
              field={`${change.tool_id} · ${change.label}`}
              before={formatToolFlagValue(change.before)}
              after={formatToolFlagValue(change.after)}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function HistoryRow({ change }: { change: TenantMcpPolicyChangeEntry }) {
  const [open, setOpen] = useState(false);
  const diff = diffMcpPolicySnapshots(change.before_policy, change.after_policy);
  const actor = change.actor_label || change.actor_user_id || 'Unknown';

  return (
    <li>
      <div className="tnt-hist-row">
        <span className="font-mono text-xs tabular-nums text-fg-muted">
          {formatWhen(change.created_at)}
        </span>
        <span className="flex min-w-0 items-center gap-2">
          <Avatar name={actor} seed={change.actor_user_id ?? actor} size="xs" />
          <span className="truncate text-sm text-fg">{actor}</span>
        </span>
        <span className="min-w-0 truncate text-sm text-fg-muted" title={diff.summary}>
          {diff.summary}
        </span>
        <Button
          variant="ghost"
          size="sm"
          className="px-1.5"
          onClick={() => setOpen((v) => !v)}
          aria-expanded={open}
          aria-label={`Toggle details for the change on ${formatWhen(change.created_at)}`}
        >
          {open ? <ChevronDown aria-hidden /> : <ChevronRight aria-hidden />}
        </Button>
      </div>
      {open ? <ChangeDetail diff={diff} /> : null}
    </li>
  );
}

export default function TenantMcpPolicyHistory({
  reloadToken = 0,
}: TenantMcpPolicyHistoryProps) {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [changes, setChanges] = useState<TenantMcpPolicyChangeEntry[]>([]);
  const [loadedOnce, setLoadedOnce] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const body = await fetchMcpPolicyHistory(HISTORY_LIMIT);
      setChanges(body.changes ?? []);
      setLoadedOnce(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load policy history');
    } finally {
      setLoading(false);
    }
  }, []);

  // Mounting is the request, and a bumped `reloadToken` is a second one: a policy save is
  // exactly the event that adds a row to this trail.
  useEffect(() => {
    void load();
  }, [reloadToken, load]);

  return (
    <section aria-labelledby="tnt-history-heading" className="space-y-3">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h3 id="tnt-history-heading" className="tnt-section-title">
            Policy history
          </h3>
          <p className="tnt-section-desc">
            Every saved change to MCP settings and key capabilities, newest first.
          </p>
        </div>
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={() => void load()}
          disabled={loading}
          aria-label="Refresh policy history"
        >
          {loading ? <Spinner size="xs" aria-hidden /> : <RefreshCw aria-hidden />}
          Refresh
        </Button>
      </div>

      {error ? <Alert variant="error">{error}</Alert> : null}

      {loading && !loadedOnce ? (
        <LoadingState message="Loading policy history…" minHeightClassName="min-h-[8rem]" />
      ) : changes.length === 0 ? (
        <p className="py-4 text-sm text-fg-muted">
          No policy changes recorded yet. Saving MCP settings will start this audit trail.
        </p>
      ) : (
        <div className="tnt-card tnt-card--flush">
          <div className="tnt-hist-row tnt-hist-row--head tnt-caps" aria-hidden>
            <span>When</span>
            <span>Actor</span>
            <span>Change</span>
            <span />
          </div>
          <ul>
            {changes.map((change) => (
              <HistoryRow key={change.id} change={change} />
            ))}
          </ul>
        </div>
      )}
    </section>
  );
}
