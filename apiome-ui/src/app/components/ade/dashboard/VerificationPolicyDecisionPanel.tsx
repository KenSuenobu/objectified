'use client';

/**
 * Publish-dialog decision panel for ECA-3.1 (#4734).
 *
 * Calls `POST /api/verification-policy/evaluate` and renders the server decision only —
 * never re-scores evidence. Parent uses `onDecisionChange` to disable publish when
 * enforcement is block and the decision failed (unless force-publish is on).
 */

import { useCallback, useEffect, useState } from 'react';
import { AlertCircle, CheckCircle2, RefreshCw, XCircle } from 'lucide-react';
import {
  verificationPolicyApi,
  type VerificationPolicyDecision,
} from '@/app/ade/dashboard/style-guides/verification-policy-api';

export default function VerificationPolicyDecisionPanel({
  projectId,
  versionId,
  projectSlug,
  versionSlug,
  enabled,
  onDecisionChange,
}: {
  projectId: string;
  versionId: string;
  projectSlug?: string;
  versionSlug?: string;
  enabled: boolean;
  onDecisionChange?: (decision: VerificationPolicyDecision | null) => void;
}) {
  const [decision, setDecision] = useState<VerificationPolicyDecision | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const evaluate = useCallback(async () => {
    if (!enabled) return;
    setLoading(true);
    setError(null);
    try {
      const body: Record<string, string> = {
        purpose: 'publish',
        projectId,
        versionId,
      };
      if (projectSlug) body.projectSlug = projectSlug;
      if (versionSlug) body.versionSlug = versionSlug;
      const result = await verificationPolicyApi<VerificationPolicyDecision>('evaluate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      setDecision(result);
      onDecisionChange?.(result);
    } catch (err) {
      setDecision(null);
      onDecisionChange?.(null);
      setError(err instanceof Error ? err.message : 'Failed to evaluate verification policy');
    } finally {
      setLoading(false);
    }
  }, [enabled, onDecisionChange, projectId, projectSlug, versionId, versionSlug]);

  useEffect(() => {
    void evaluate();
  }, [evaluate]);

  if (!enabled) return null;

  return (
    <div className="space-y-2 rounded-lg border border-slate-200 bg-slate-50/80 p-3 dark:border-slate-700 dark:bg-slate-900/40">
      <div className="flex items-center justify-between gap-2">
        <h3 className="text-sm font-semibold text-gray-900 dark:text-white">
          Verification policy
        </h3>
        <button
          type="button"
          onClick={() => void evaluate()}
          disabled={loading}
          className="inline-flex items-center gap-1 text-xs text-gray-500 hover:text-gray-800 disabled:opacity-50 dark:hover:text-gray-200"
        >
          <RefreshCw className={`h-3.5 w-3.5 ${loading ? 'animate-spin' : ''}`} aria-hidden />
          Re-evaluate
        </button>
      </div>

      {error && (
        <div className="flex items-start gap-2 text-sm text-rose-700 dark:text-rose-300">
          <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
          <span>{error}</span>
        </div>
      )}

      {loading && !decision && (
        <p className="text-sm text-gray-500">Evaluating evidence-backed policy…</p>
      )}

      {decision && (
        <div className="space-y-2 text-sm">
          <div className="flex flex-wrap items-center gap-2">
            {decision.passed ? (
              <span className="inline-flex items-center gap-1 rounded-full bg-emerald-50 px-2 py-0.5 text-xs font-medium text-emerald-800 dark:bg-emerald-950 dark:text-emerald-200">
                <CheckCircle2 className="h-3.5 w-3.5" aria-hidden />
                Passed
              </span>
            ) : (
              <span className="inline-flex items-center gap-1 rounded-full bg-rose-50 px-2 py-0.5 text-xs font-medium text-rose-800 dark:bg-rose-950 dark:text-rose-200">
                <XCircle className="h-3.5 w-3.5" aria-hidden />
                Failed
              </span>
            )}
            <span className="text-xs text-gray-500">
              enforcement: {decision.enforcement}
              {decision.skipped ? ' · purpose not covered' : ''}
            </span>
          </div>

          {decision.evaluationId && (
            <p className="font-mono text-[11px] text-gray-500">
              evaluationId: {decision.evaluationId}
            </p>
          )}

          {decision.evidenceRunIds.length > 0 && (
            <div>
              <p className="text-xs font-medium text-gray-600 dark:text-gray-300">
                Cited evidence runs
              </p>
              <ul className="mt-1 space-y-0.5 font-mono text-[11px] text-gray-500">
                {decision.evidenceRunIds.map((id) => (
                  <li key={id}>{id}</li>
                ))}
              </ul>
            </div>
          )}

          <ul className="space-y-1">
            {decision.gateResults.map((gate) => (
              <li
                key={gate.gate}
                className="flex items-center justify-between gap-2 rounded border border-slate-200/80 bg-white px-2 py-1 dark:border-slate-700 dark:bg-slate-950"
              >
                <span className="font-mono text-xs">{gate.gate}</span>
                <span
                  className={
                    gate.passed
                      ? 'text-xs text-emerald-700 dark:text-emerald-300'
                      : 'text-xs text-rose-700 dark:text-rose-300'
                  }
                >
                  {gate.passed ? 'pass' : 'fail'}
                  {gate.action ? ` · ${gate.action}` : ''}
                </span>
              </li>
            ))}
          </ul>

          {decision.warnings.length > 0 && (
            <ul className="space-y-1 text-xs text-amber-800 dark:text-amber-200">
              {decision.warnings.map((w, i) => (
                <li key={i}>{String(w.message || JSON.stringify(w))}</li>
              ))}
            </ul>
          )}

          {!decision.passed && decision.enforcement === 'block' && (
            <p className="text-xs text-rose-700 dark:text-rose-300">
              Policy enforcement is block — resolve failed gates or use force publish with a
              reason.
            </p>
          )}
        </div>
      )}
    </div>
  );
}
