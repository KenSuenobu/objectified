'use client';

/**
 * Publish-dialog decision panel for ECA-3.1 (#4734).
 *
 * Calls `POST /api/verification-policy/evaluate` and renders the server decision only —
 * never re-scores evidence. Parent uses `onDecisionChange` to disable publish when
 * enforcement is block and the decision failed (unless force-publish is on).
 *
 * Re-skinned in place by HIVE-6.2 (#5313) to `docs/mockups/build/versions.html`'s third
 * publish gate (`.gate`): the titled head with the Passed / Failed badge and the re-evaluate
 * button, the enforcement and evaluation-id line, the cited runs, then one row per gate.
 * What it evaluates and what it reports through `onDecisionChange` are unchanged.
 */

import { useCallback, useEffect, useState } from 'react';
import { AlertCircle, BadgeCheck, CheckCircle2, RefreshCw, XCircle } from 'lucide-react';
import { Alert } from '../../ui/Alert';
import { Badge } from '../../ui/Badge';
import { Button } from '../../ui/Button';
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
    <div className="ver-gate" data-testid="verification-policy-panel">
      <div className="ver-gate__head">
        <h3 className="ver-gate__title">
          <BadgeCheck aria-hidden />
          Verification policy
        </h3>
        <span className="ver-gate__badges">
          {decision ? (
            decision.passed ? (
              <Badge status="passed">
                <CheckCircle2 aria-hidden />
                Passed
              </Badge>
            ) : (
              <Badge status="failed">
                <XCircle aria-hidden />
                Failed
              </Badge>
            )
          ) : null}
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="px-1.5"
            onClick={() => void evaluate()}
            disabled={loading}
            title="Re-evaluate"
            aria-label="Re-evaluate"
          >
            <RefreshCw className={loading ? 'animate-spin' : undefined} aria-hidden />
          </Button>
        </span>
      </div>

      {error && (
        <Alert variant="error" icon={<AlertCircle aria-hidden />} className="ver-gate__banner">
          {error}
        </Alert>
      )}

      {loading && !decision && <p className="ver-gate__note">Evaluating evidence-backed policy…</p>}

      {decision && (
        <>
          <p className="ver-gate__sub">
            enforcement: {decision.enforcement}
            {decision.skipped ? ' · purpose not covered' : ''}
            {decision.evaluationId ? (
              <>
                {' · evaluationId: '}
                <span className="mono">{decision.evaluationId}</span>
              </>
            ) : null}
          </p>

          {decision.evidenceRunIds.length > 0 && (
            <p className="ver-gate__sub">
              Cited evidence runs:{' '}
              {decision.evidenceRunIds.map((id, index) => (
                <span key={id}>
                  {index > 0 ? ', ' : ''}
                  <span className="mono">{id}</span>
                </span>
              ))}
            </p>
          )}

          <ul className="ver-gate__findings ver-gate__findings--gates">
            {decision.gateResults.map((gate) => (
              <li key={gate.gate} className="ver-gate__gate-row">
                <span className="mono">{gate.gate}</span>
                <Badge status={gate.passed ? 'passed' : 'failed'}>
                  {gate.passed ? 'pass' : 'fail'}
                  {gate.action ? ` · ${gate.action}` : ''}
                </Badge>
              </li>
            ))}
          </ul>

          {decision.warnings.length > 0 && (
            <Alert variant="warning" className="ver-gate__banner">
              <ul className="ver-gate__warnings">
                {decision.warnings.map((w, i) => (
                  <li key={i}>{String(w.message || JSON.stringify(w))}</li>
                ))}
              </ul>
            </Alert>
          )}

          {!decision.passed && decision.enforcement === 'block' && (
            <Alert variant="error" className="ver-gate__banner">
              Policy enforcement is block — resolve failed gates or use force publish with a
              reason.
            </Alert>
          )}
        </>
      )}
    </div>
  );
}
