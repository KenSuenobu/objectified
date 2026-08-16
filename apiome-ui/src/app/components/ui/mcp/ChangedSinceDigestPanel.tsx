'use client';

/**
 * "Changed since last view" digest panel (V2-MCP-30.5 / MCAT-16.5).
 *
 * Greets a returning user with a per-user summary of what changed on the endpoint's surface since
 * they last looked, and how breaking it is. It has three states, driven by the pure, unit-tested
 * {@link mcpDigestState} projection so the copy and the data can never disagree:
 *
 * - **New to you** — the user has never viewed this endpoint (or the snapshot they last saw was
 *   pruned). Shows the current surface size so they know what they are looking at.
 * - **Changed** — the surface moved on since their last view. Shows the per-severity and
 *   per-direction tallies, a compact list of the changes, a prominent callout when any are
 *   breaking, and a "Review changes" button that deep-links to the current version's diff.
 * - **Up to date** — nothing changed since the last view; a calm, compact acknowledgement.
 *
 * The panel owns its loading / error states. Reading the digest does not advance the seen-marker
 * (the Insight tab does that separately after the digest loads), so this always reflects the
 * pre-advance "since your last visit" delta.
 */

import * as React from 'react';
import {
  ArrowRight,
  CheckCircle2,
  History,
  Minus,
  MousePointerClick,
  PencilLine,
  Plus,
  ShieldAlert,
  Sparkles,
} from 'lucide-react';
import { EmptyState } from '@/app/components/ui/EmptyState';
import { LoadingState } from '@/app/components/ui/LoadingState';
import { mcpVersionSeqLabel } from '@/app/components/ade/dashboard/mcp/mcpVersionsUi';
import {
  mcpDigestSeenDate,
  mcpDigestState,
  type McpDigestChange,
  type McpEndpointDigest,
} from '@/app/components/ade/dashboard/mcp/mcpDigestUi';

interface Props {
  /** The parsed digest, or `null` while it has not loaded. */
  digest: McpEndpointDigest | null;
  loading: boolean;
  error: string | null;
  /** Called with the current `version_id` when "Review changes" is activated (deep-links its diff). */
  onReviewChanges: (versionId: string) => void;
}

/** How many individual changes to list before collapsing the rest into a "+N more" note. */
const MAX_LISTED_CHANGES = 6;

/** Tailwind class atoms per severity — token-driven, no literal colors in the render. */
const SEVERITY_STYLES: Record<string, { chip: string; label: string }> = {
  breaking: {
    chip: 'border-red-200 bg-red-50 text-red-700 dark:border-red-900/50 dark:bg-red-900/20 dark:text-red-300',
    label: 'breaking',
  },
  review: {
    chip: 'border-amber-200 bg-amber-50 text-amber-700 dark:border-amber-900/50 dark:bg-amber-900/20 dark:text-amber-300',
    label: 'review',
  },
  additive: {
    chip: 'border-emerald-200 bg-emerald-50 text-emerald-700 dark:border-emerald-900/50 dark:bg-emerald-900/20 dark:text-emerald-300',
    label: 'additive',
  },
};

function severityStyle(severity: string) {
  return SEVERITY_STYLES[severity] ?? SEVERITY_STYLES.review;
}

/** A small, tinted count chip (only rendered for a non-zero count). */
function CountChip({ count, className, children }: { count: number; className: string; children: React.ReactNode }) {
  if (count <= 0) return null;
  return (
    <span
      className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-xs font-medium tabular-nums ${className}`}
    >
      {children}
    </span>
  );
}

/** The change-type glyph for one change row. */
function ChangeGlyph({ changeType }: { changeType: string }) {
  if (changeType === 'added') {
    return <Plus className="h-3.5 w-3.5 shrink-0 text-emerald-500 dark:text-emerald-400" aria-hidden />;
  }
  if (changeType === 'removed') {
    return <Minus className="h-3.5 w-3.5 shrink-0 text-red-500 dark:text-red-400" aria-hidden />;
  }
  return <PencilLine className="h-3.5 w-3.5 shrink-0 text-amber-500 dark:text-amber-400" aria-hidden />;
}

/** One change row: its direction glyph, item name/type, and severity chip. */
function ChangeRow({ change }: { change: McpDigestChange }) {
  const style = severityStyle(change.severity);
  return (
    <li className="flex items-center justify-between gap-2 py-1">
      <span className="flex min-w-0 items-center gap-1.5">
        <ChangeGlyph changeType={change.change_type} />
        <span className="truncate text-sm text-gray-800 dark:text-gray-100">{change.item_name}</span>
        <span className="shrink-0 text-xs text-gray-400 dark:text-gray-500">{change.item_type}</span>
      </span>
      <span
        className={`shrink-0 rounded-full border px-2 py-0.5 text-2xs font-medium uppercase tracking-wider ${style.chip}`}
      >
        {style.label}
      </span>
    </li>
  );
}

/** The "changed since last view" body: severity/direction tallies, the change list, and the CTA. */
function ChangedBody({ digest, onReviewChanges }: { digest: McpEndpointDigest; onReviewChanges: (id: string) => void }) {
  const seenDate = mcpDigestSeenDate(digest);
  const { breaking, additive, review } = digest.severity_counts;
  const { added, removed, modified } = digest.change_counts;
  const listed = digest.changes.slice(0, MAX_LISTED_CHANGES);
  const overflow = digest.changes.length - listed.length;

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-gray-500 dark:text-gray-400">
        <span>
          Since{' '}
          <span className="font-medium text-gray-700 dark:text-gray-200">
            {digest.last_seen_version_seq !== null
              ? mcpVersionSeqLabel(digest.last_seen_version_seq)
              : 'your last visit'}
          </span>
          {seenDate ? <span> ({seenDate})</span> : null}
        </span>
        <ArrowRight className="h-3.5 w-3.5" aria-hidden />
        <span className="font-medium text-gray-700 dark:text-gray-200">
          {digest.current_version_seq !== null ? mcpVersionSeqLabel(digest.current_version_seq) : 'now'}
        </span>
      </div>

      {/* Breaking-change callout — the headline the user most needs when any change breaks. */}
      {breaking > 0 ? (
        <div
          role="alert"
          className="flex items-start gap-2 rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-800 dark:border-red-900/50 dark:bg-red-900/20 dark:text-red-200"
        >
          <ShieldAlert className="mt-0.5 h-4 w-4 shrink-0 text-red-500 dark:text-red-400" aria-hidden />
          <span>
            <span className="font-semibold tabular-nums">{breaking}</span>{' '}
            {breaking === 1 ? 'breaking change' : 'breaking changes'} since you last looked — a client
            aligned to the older surface may break.
          </span>
        </div>
      ) : null}

      {/* Per-severity and per-direction tallies. */}
      <div className="flex flex-wrap items-center gap-1.5">
        <CountChip count={breaking} className={SEVERITY_STYLES.breaking.chip}>
          {breaking} breaking
        </CountChip>
        <CountChip count={review} className={SEVERITY_STYLES.review.chip}>
          {review} review
        </CountChip>
        <CountChip count={additive} className={SEVERITY_STYLES.additive.chip}>
          {additive} additive
        </CountChip>
        <span className="mx-1 h-4 w-px bg-gray-200 dark:bg-gray-700" aria-hidden />
        <span className="inline-flex items-center gap-2 text-xs tabular-nums text-gray-500 dark:text-gray-400">
          <span className="text-emerald-600 dark:text-emerald-400">+{added}</span>
          <span className="text-red-600 dark:text-red-400">−{removed}</span>
          <span className="text-amber-600 dark:text-amber-400">~{modified}</span>
        </span>
      </div>

      {/* The individual changes (capped, with a "+N more" note). */}
      {listed.length > 0 ? (
        <ul className="divide-y divide-gray-100 dark:divide-gray-800">
          {listed.map((change) => (
            <ChangeRow key={`${change.item_type}:${change.item_name}:${change.change_type}`} change={change} />
          ))}
        </ul>
      ) : null}
      {overflow > 0 ? (
        <p className="text-xs text-gray-500 dark:text-gray-400">
          + <span className="font-medium tabular-nums">{overflow}</span> more{' '}
          {overflow === 1 ? 'change' : 'changes'}.
        </p>
      ) : null}

      {digest.current_version_id ? (
        <button
          type="button"
          onClick={() => onReviewChanges(digest.current_version_id as string)}
          className="inline-flex items-center gap-1.5 rounded-md border border-indigo-200 bg-indigo-50 px-3 py-1.5 text-sm font-medium text-indigo-700 transition-colors hover:bg-indigo-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500 dark:border-indigo-900/50 dark:bg-indigo-900/20 dark:text-indigo-300 dark:hover:bg-indigo-900/30"
        >
          <MousePointerClick className="h-3.5 w-3.5" aria-hidden />
          Review changes
        </button>
      ) : null}
    </div>
  );
}

/** The "new to you" body: the current surface size so a first-time viewer knows what they see. */
function NewBody({ digest }: { digest: McpEndpointDigest }) {
  const { tools, resources, resource_templates, prompts, total } = digest.current_type_counts;
  const parts: string[] = [];
  if (tools > 0) parts.push(`${tools} ${tools === 1 ? 'tool' : 'tools'}`);
  if (resources > 0) parts.push(`${resources} ${resources === 1 ? 'resource' : 'resources'}`);
  if (resource_templates > 0)
    parts.push(`${resource_templates} ${resource_templates === 1 ? 'template' : 'templates'}`);
  if (prompts > 0) parts.push(`${prompts} ${prompts === 1 ? 'prompt' : 'prompts'}`);

  return (
    <div className="flex items-start gap-3">
      <Sparkles className="mt-0.5 h-5 w-5 shrink-0 text-indigo-400" aria-hidden />
      <div className="space-y-1">
        <p className="text-sm font-medium text-gray-900 dark:text-white">New to you</p>
        <p className="text-sm text-gray-600 dark:text-gray-300">
          {total > 0
            ? `You haven't viewed this endpoint before — it currently exposes ${parts.join(', ')}.`
            : "You haven't viewed this endpoint before. It has no capabilities to summarize yet."}
        </p>
      </div>
    </div>
  );
}

/** The "up to date" body: a compact, reassuring acknowledgement. */
function CurrentBody({ digest }: { digest: McpEndpointDigest }) {
  return (
    <div className="flex items-center gap-2 text-sm text-gray-600 dark:text-gray-300">
      <CheckCircle2 className="h-4 w-4 shrink-0 text-emerald-500 dark:text-emerald-400" aria-hidden />
      <span>
        You&apos;re up to date — nothing has changed since you last viewed{' '}
        <span className="font-medium text-gray-800 dark:text-gray-100">
          {digest.current_version_seq !== null ? mcpVersionSeqLabel(digest.current_version_seq) : 'this endpoint'}
        </span>
        .
      </span>
    </div>
  );
}

/**
 * The "changed since last view" digest panel. See the module doc for the three states it renders and
 * the acceptance criteria it satisfies (the delta reflects last-seen → current, a first visit reads
 * as "new to you", and breaking changes are called out prominently).
 */
export function ChangedSinceDigestPanel({ digest, loading, error, onReviewChanges }: Props) {
  if (loading && !digest) {
    return <LoadingState minHeightClassName="min-h-[80px]" message="Checking what changed…" />;
  }
  if (error) {
    return (
      <EmptyState
        variant="compact"
        icon={<History className="h-8 w-8 text-white" aria-hidden />}
        title="Digest unavailable"
        description={error}
      />
    );
  }
  if (!digest) return null;

  const state = mcpDigestState(digest);
  return (
    <div aria-busy={loading}>
      {state === 'changed' ? (
        <ChangedBody digest={digest} onReviewChanges={onReviewChanges} />
      ) : state === 'new' ? (
        <NewBody digest={digest} />
      ) : (
        <CurrentBody digest={digest} />
      )}
    </div>
  );
}
