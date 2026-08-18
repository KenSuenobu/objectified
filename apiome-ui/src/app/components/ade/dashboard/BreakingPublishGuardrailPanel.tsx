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
 *
 * Re-skinned in place by HIVE-6.2 (#5313) to `docs/mockups/build/versions.html`'s second
 * publish gate (`.gate` on `--warn-soft`): the titled head with the status badge, the *vX
 * versus vY* line, the verdict, the recommended version and the *Breaking changes (n)*
 * disclosure. What it loads, what it reports through `onGuardrailChange` and when it blocks
 * are unchanged; the status badge takes its tone from the shared vocabulary.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ChevronDown, ChevronRight, OctagonAlert } from 'lucide-react';
import { Alert } from '../../ui/Alert';
import { Badge } from '../../ui/Badge';
import { LoadingState } from '../../ui/LoadingState';
import type { StatusTone } from '../../ui/statusVocabulary';
import {
  fetchBreakingPublishGuardrail,
  guardrailStatusLabel,
  type BreakingPublishGuardrail,
} from '@/app/utils/breaking-publish-guardrail';

/** The vocabulary tone for each guardrail verdict — the mockup's `Blocked` is danger, a warning warn. */
const GUARDRAIL_STATUS_TONE: Readonly<Record<string, StatusTone>> = {
  blocked: 'danger',
  warning: 'warn',
  ok: 'ok',
  'no-baseline': 'accent',
  disabled: 'outline',
  unavailable: 'outline',
};

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
      <div className="ver-gate" data-testid="breaking-publish-guardrail-loading">
        <div className="ver-gate__head">
          <h3 className="ver-gate__title">
            <OctagonAlert aria-hidden />
            Breaking changes
          </h3>
        </div>
        <LoadingState
          className="ver-gate__loading"
          minHeightClassName="min-h-0"
          spinnerSize="sm"
          message="Checking breaking changes…"
        />
      </div>
    );
  }

  if (error) {
    return (
      <Alert variant="warning" data-testid="breaking-publish-guardrail-error">
        Could not check for breaking changes: {error}
      </Alert>
    );
  }

  // Nothing to say — a compatible or properly-majored release sees no friction at all.
  if (!guardrail || !guardrail.triggered) return null;

  const changeCount = guardrail.breakingCount;
  const versionLabel = guardrail.toVersion ?? 'this version';
  const baselineLabel = guardrail.fromVersion ?? 'the previous published version';
  const tone = GUARDRAIL_STATUS_TONE[guardrail.status] ?? 'neutral';

  return (
    <div className="ver-gate ver-gate--warn" data-testid="breaking-publish-guardrail-panel">
      <div className="ver-gate__head">
        <h3 className="ver-gate__title">
          <OctagonAlert aria-hidden />
          Breaking changes
        </h3>
        <Badge variant={tone} data-testid="breaking-publish-guardrail-status">
          {guardrailStatusLabel(guardrail.status)}
        </Badge>
      </div>
      <p className="ver-gate__sub">
        {versionLabel} versus {baselineLabel}
      </p>

      <Alert variant={guardrail.blocked ? 'error' : 'warning'} className="ver-gate__banner">
        {guardrail.message}
        {guardrail.blocked
          ? ' Publishing is blocked by your tenant policy — bump the major version or use force publish with a reason.'
          : ''}
      </Alert>

      {guardrail.recommendedVersion && (
        <p className="ver-gate__note">
          Recommended version:{' '}
          <span className="ver-gate__em mono" data-testid="breaking-publish-recommended-version">
            {guardrail.recommendedVersion}
          </span>
        </p>
      )}

      {listedChanges.length > 0 && (
        <div className="ver-gate__disclosure">
          <button
            type="button"
            className="ver-gate__toggle"
            onClick={() => setChangesExpanded((v) => !v)}
            aria-expanded={changesExpanded}
            data-testid="breaking-publish-changes-toggle"
          >
            {changesExpanded ? <ChevronDown aria-hidden /> : <ChevronRight aria-hidden />}
            Breaking changes ({changeCount})
          </button>
          {changesExpanded && (
            <>
              <ul className="ver-gate__findings">
                {listedChanges.map((change) => (
                  <li
                    key={`${change.ruleId}:${change.pointer}`}
                    className="ver-gate__finding"
                    data-testid="breaking-publish-change"
                  >
                    <span className="ver-gate__tag mono">{change.ruleId}</span>
                    <span className="ver-gate__path mono">{change.pointer}</span>
                    <span className="ver-gate__message">{change.summary}</span>
                  </li>
                ))}
              </ul>
              {guardrail.truncated && (
                <p className="ver-gate__truncated" data-testid="breaking-publish-changes-truncated">
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
