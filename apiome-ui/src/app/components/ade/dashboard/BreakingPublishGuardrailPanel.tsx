'use client';

/**
 * Breaking-publish guardrail summary for the publish dialog (CTG-3.4, #4478).
 *
 * Loads the server assessment for the revision being published and surfaces the verdict: which
 * changes break consumers, whether the semver major was bumped, and — when the tenant policy is
 * `block` — that publish is refused until the major is bumped or the publish is forced.
 *
 * Silent by design when there is nothing to say (not breaking, correctly majored, initial
 * publication, guardrail off), so a well-formed release sees no friction.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ChevronDown, ChevronRight } from 'lucide-react';
import { Alert } from '../../ui/Alert';
import { LoadingState } from '../../ui/LoadingState';
import {
  fetchBreakingPublishGuardrail,
  guardrailStatusBadgeClass,
  guardrailStatusLabel,
  type BreakingPublishGuardrail,
} from '@/app/utils/breaking-publish-guardrail';

export interface BreakingPublishGuardrailPanelProps {
  projectId: string;
  versionId: string;
  /** Only fetch while the dialog is open. */
  enabled?: boolean;
  /** Called when the assessment finishes loading (or fails). */
  onGuardrailChange?: (guardrail: BreakingPublishGuardrail | null, error: string | null) => void;
}

/**
 * Render the guardrail verdict and its expandable breaking-change list for publish.
 */
export function BreakingPublishGuardrailPanel({
  projectId,
  versionId,
  enabled = true,
  onGuardrailChange,
}: BreakingPublishGuardrailPanelProps) {
  const [guardrail, setGuardrail] = useState<BreakingPublishGuardrail | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [changesExpanded, setChangesExpanded] = useState(false);
  const abortRef = useRef<AbortController | null>(null);
  // Held in a ref, and synced in an effect rather than during render, so a parent that
  // recreates the callback every render cannot retrigger the fetch in a loop.
  const onGuardrailChangeRef = useRef(onGuardrailChange);
  useEffect(() => {
    onGuardrailChangeRef.current = onGuardrailChange;
  }, [onGuardrailChange]);

  const loadGuardrail = useCallback(async () => {
    if (!enabled) return;
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    setLoading(true);
    setError(null);
    try {
      const assessment = await fetchBreakingPublishGuardrail(projectId, versionId, {
        signal: controller.signal,
      });
      if (controller.signal.aborted) return;
      setGuardrail(assessment);
      setLoading(false);
      onGuardrailChangeRef.current?.(assessment, null);
    } catch (e: unknown) {
      if (controller.signal.aborted) return;
      const message = e instanceof Error ? e.message : 'Failed to load breaking-change guardrail';
      setGuardrail(null);
      setError(message);
      setLoading(false);
      onGuardrailChangeRef.current?.(null, message);
    }
  }, [enabled, projectId, versionId]);

  useEffect(() => {
    // The fetch flips `loading` before it awaits, which the lint rule reads as a setState in an
    // effect. That is the intended behavior for a load-on-open panel: the dialog must show the
    // spinner immediately, and the in-flight request is aborted on close by the cleanup below.
    // eslint-disable-next-line react-hooks/set-state-in-effect -- load-on-open fetch, aborted on close
    void loadGuardrail();
    return () => abortRef.current?.abort();
  }, [loadGuardrail]);

  const listedChanges = useMemo(() => guardrail?.breakingChanges ?? [], [guardrail]);

  if (!enabled) return null;

  if (loading) {
    return (
      <LoadingState
        className="py-4"
        minHeightClassName="min-h-0"
        spinnerSize="sm"
        message="Checking breaking changes…"
      />
    );
  }

  if (error) {
    return (
      <Alert variant="warning" className="text-sm" data-testid="breaking-publish-guardrail-error">
        Could not check for breaking changes: {error}
      </Alert>
    );
  }

  // Nothing to say — a compatible or properly-majored release sees no friction at all.
  if (!guardrail || !guardrail.triggered) return null;

  const changeCount = guardrail.breakingCount;
  const versionLabel = guardrail.toVersion ?? 'this version';
  const baselineLabel = guardrail.fromVersion ?? 'the previous published version';

  return (
    <div
      className="space-y-3 rounded-lg border border-amber-200 bg-amber-50/70 p-4 dark:border-amber-800/70 dark:bg-amber-950/20"
      data-testid="breaking-publish-guardrail-panel"
    >
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <div>
          <h3 className="text-sm font-semibold text-gray-900 dark:text-gray-100">
            Breaking changes
          </h3>
          <p className="mt-0.5 text-xs text-gray-600 dark:text-gray-400">
            {versionLabel} versus {baselineLabel}
          </p>
        </div>
        <span
          className={`rounded-md px-2 py-0.5 text-xs font-medium ${guardrailStatusBadgeClass(guardrail.status)}`}
          data-testid="breaking-publish-guardrail-status"
        >
          {guardrailStatusLabel(guardrail.status)}
        </span>
      </div>

      <Alert variant={guardrail.blocked ? 'error' : 'warning'} className="text-sm">
        {guardrail.message}
        {guardrail.blocked
          ? ' Publishing is blocked by your tenant policy — bump the major version or use force publish with a reason.'
          : ''}
      </Alert>

      {guardrail.recommendedVersion && (
        <p className="text-xs text-gray-600 dark:text-gray-400">
          Recommended version:{' '}
          <span
            className="font-mono font-medium text-gray-900 dark:text-gray-100"
            data-testid="breaking-publish-recommended-version"
          >
            {guardrail.recommendedVersion}
          </span>
        </p>
      )}

      {listedChanges.length > 0 && (
        <div className="rounded-md border border-gray-200 bg-white dark:border-gray-700 dark:bg-gray-900/60">
          <button
            type="button"
            className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm font-medium text-gray-800 dark:text-gray-200"
            onClick={() => setChangesExpanded((v) => !v)}
            aria-expanded={changesExpanded}
            data-testid="breaking-publish-changes-toggle"
          >
            {changesExpanded ? (
              <ChevronDown className="h-4 w-4 shrink-0" aria-hidden />
            ) : (
              <ChevronRight className="h-4 w-4 shrink-0" aria-hidden />
            )}
            Breaking changes ({changeCount})
          </button>
          {changesExpanded && (
            <>
              <ul className="max-h-48 space-y-2 overflow-y-auto border-t border-gray-200 px-3 py-2 dark:border-gray-700">
                {listedChanges.map((change) => (
                  <li
                    key={`${change.ruleId}:${change.pointer}`}
                    className="text-xs text-gray-700 dark:text-gray-300"
                    data-testid="breaking-publish-change"
                  >
                    <span className="font-mono text-2xs text-rose-700 dark:text-rose-300">
                      {change.ruleId}
                    </span>
                    <span className="mt-0.5 block font-mono text-2xs text-gray-500 dark:text-gray-400">
                      {change.pointer}
                    </span>
                    <span className="mt-0.5 block text-gray-600 dark:text-gray-400">
                      {change.summary}
                    </span>
                  </li>
                ))}
              </ul>
              {guardrail.truncated && (
                <p
                  className="border-t border-gray-200 px-3 py-2 text-xs text-gray-500 dark:border-gray-700 dark:text-gray-400"
                  data-testid="breaking-publish-changes-truncated"
                >
                  Showing {listedChanges.length} of {changeCount} — see the change report for the
                  full list.
                </p>
              )}
            </>
          )}
        </div>
      )}
    </div>
  );
}
