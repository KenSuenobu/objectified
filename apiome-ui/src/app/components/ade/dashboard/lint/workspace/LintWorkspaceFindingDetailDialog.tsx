'use client';

/**
 * Finding detail dialog for the lint workspace (CLX-4.1, #4859).
 *
 * Links everything acceptance criterion 2 names for one finding: the evidence (scanner,
 * profile, fingerprint, source location, remediation hint), the revision it was found on,
 * the policy decision (latest evaluation pass/fail + decision row), and the remediation
 * history (the decision's append-only audit events, fetched lazily when a decision exists).
 */

import React, { useEffect, useState } from 'react';
import Link from 'next/link';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/app/components/ui';
import { severityBadgeClass } from '@/app/utils/version-lint-report';
import { LintDecisionBadge } from '@/app/utils/lint-policy-ui';
import type { LintWorkspaceFinding } from '@/app/utils/lint-workspace';
import { cn } from '@lib/utils';

interface DecisionEvent {
  id: string;
  beforeState: string | null;
  afterState: string;
  rationale: string | null;
  actorLabel: string | null;
  createdAt: string | null;
}

const sectionTitleClass =
  'text-xs font-semibold uppercase tracking-wider text-gray-500 dark:text-gray-400';
const dtClass = 'text-xs text-gray-500 dark:text-gray-400';
const ddClass = 'text-sm text-gray-900 dark:text-gray-100 break-all';

function eventsFromPayload(v: unknown): DecisionEvent[] {
  if (!Array.isArray(v)) return [];
  return v.map((entry) => {
    const e = (entry ?? {}) as Record<string, unknown>;
    return {
      id: String(e.id ?? ''),
      beforeState: typeof e.beforeState === 'string' ? e.beforeState : null,
      afterState: typeof e.afterState === 'string' ? e.afterState : 'open',
      rationale: typeof e.rationale === 'string' ? e.rationale : null,
      actorLabel: typeof e.actorLabel === 'string' ? e.actorLabel : null,
      createdAt: typeof e.createdAt === 'string' ? e.createdAt : null,
    };
  });
}

export interface LintWorkspaceFindingDetailDialogProps {
  finding: LintWorkspaceFinding | null;
  onClose: () => void;
}

/** Modal detail view for one queue finding. */
export default function LintWorkspaceFindingDetailDialog({
  finding,
  onClose,
}: LintWorkspaceFindingDetailDialogProps) {
  // History is keyed by the decision it was fetched for, so switching findings shows the
  // loading state (a stale entry simply no longer matches) without resetting state in-effect.
  const [history, setHistory] = useState<{
    forId: string;
    events: DecisionEvent[] | null;
    error: string | null;
  } | null>(null);
  const decisionId = finding?.decision?.id ?? null;
  const events = history?.forId === decisionId ? history.events : null;
  const eventsError = history?.forId === decisionId ? history.error : null;

  useEffect(() => {
    if (!decisionId) return;
    const controller = new AbortController();
    fetch(`/api/lint/decisions/${encodeURIComponent(decisionId)}/events`, {
      signal: controller.signal,
    })
      .then(async (res) => {
        const data = await res.json().catch(() => null);
        if (!res.ok || !data?.success) {
          throw new Error(data?.error || `HTTP ${res.status}`);
        }
        setHistory({ forId: decisionId, events: eventsFromPayload(data.events), error: null });
      })
      .catch((e: unknown) => {
        if ((e as Error)?.name !== 'AbortError') {
          setHistory({
            forId: decisionId,
            events: null,
            error: e instanceof Error ? e.message : 'Failed to load history',
          });
        }
      });
    return () => controller.abort();
  }, [decisionId]);

  if (!finding) return null;

  const revisionHref = finding.versionRecordId
    ? `/ade/dashboard/versions?projectId=${encodeURIComponent(finding.projectId ?? '')}`
    : finding.mcpVersionId
      ? `/ade/dashboard/mcp`
      : null;
  const remediationText =
    finding.remediation && typeof finding.remediation.fix === 'string'
      ? (finding.remediation.fix as string)
      : finding.remediation && typeof finding.remediation.summary === 'string'
        ? (finding.remediation.summary as string)
        : null;
  const linkedTicket = finding.decision?.linkedTicket ?? null;

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent
        data-testid="finding-detail-dialog"
        className="max-h-[85vh] max-w-2xl overflow-y-auto"
      >
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <span>{finding.ruleId ?? 'Finding'}</span>
            <span
              className={cn(
                'inline-flex items-center rounded px-1.5 py-0.5 text-2xs font-semibold uppercase tracking-wide',
                severityBadgeClass(finding.severity ?? ''),
              )}
            >
              {finding.severity ?? '—'}
            </span>
            <LintDecisionBadge state={finding.effectiveState} waived={finding.waived} />
          </DialogTitle>
          <DialogDescription>{finding.message}</DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <section data-testid="detail-evidence">
            <h3 className={sectionTitleClass}>Evidence</h3>
            <dl className="mt-1 grid grid-cols-2 gap-x-4 gap-y-2">
              <div>
                <dt className={dtClass}>Scanner</dt>
                <dd className={cn(ddClass, 'font-mono text-xs')}>{finding.scannerId}</dd>
              </div>
              <div>
                <dt className={dtClass}>Profile</dt>
                <dd className={ddClass}>{finding.profile ?? '—'}</dd>
              </div>
              <div>
                <dt className={dtClass}>Evidence run</dt>
                <dd className={cn(ddClass, 'font-mono text-xs')} data-testid="detail-evidence-run">
                  {finding.evidenceRunId ?? '—'}
                </dd>
              </div>
              <div>
                <dt className={dtClass}>Recorded</dt>
                <dd className={ddClass}>{finding.evidenceCreatedAt ?? '—'}</dd>
              </div>
              <div>
                <dt className={dtClass}>Fingerprint</dt>
                <dd className={cn(ddClass, 'font-mono text-xs')}>
                  {finding.sourceFingerprint ?? '—'}
                </dd>
              </div>
              <div>
                <dt className={dtClass}>Location</dt>
                <dd className={cn(ddClass, 'font-mono text-xs')} data-testid="detail-location">
                  {Object.entries(finding.location)
                    .map(([key, value]) => `${key}: ${String(value)}`)
                    .join(', ') || '—'}
                </dd>
              </div>
            </dl>
            {remediationText && (
              <p className="mt-2 rounded bg-emerald-50 p-2 text-xs text-emerald-900 dark:bg-emerald-900/30 dark:text-emerald-200">
                {remediationText}
              </p>
            )}
          </section>

          <section data-testid="detail-links">
            <h3 className={sectionTitleClass}>Links</h3>
            <ul className="mt-1 space-y-1 text-sm">
              <li>
                <span className={dtClass}>Subject: </span>
                {revisionHref ? (
                  <Link
                    href={revisionHref}
                    data-testid="detail-subject-link"
                    className="text-indigo-600 hover:underline dark:text-indigo-400"
                  >
                    {finding.projectName ?? finding.subjectLabel ?? 'Open subject'}
                    {finding.subjectLabel && finding.projectName
                      ? ` · ${finding.subjectLabel}`
                      : ''}
                  </Link>
                ) : (
                  <span className={ddClass}>{finding.subjectLabel ?? '—'}</span>
                )}
              </li>
              <li>
                <span className={dtClass}>Policy: </span>
                <span data-testid="detail-policy" className={ddClass}>
                  {finding.policyPassed === null
                    ? 'Not evaluated'
                    : finding.policyPassed
                      ? 'Passed'
                      : 'Failed'}
                  {finding.latestPolicyEvaluationId
                    ? ` (evaluation ${finding.latestPolicyEvaluationId})`
                    : ''}
                </span>
              </li>
              {linkedTicket && (
                <li>
                  <span className={dtClass}>Ticket: </span>
                  <a
                    href={linkedTicket}
                    target="_blank"
                    rel="noreferrer"
                    data-testid="detail-linked-ticket"
                    className="text-indigo-600 hover:underline dark:text-indigo-400"
                  >
                    {linkedTicket}
                  </a>
                </li>
              )}
            </ul>
          </section>

          <section data-testid="detail-history">
            <h3 className={sectionTitleClass}>Remediation history</h3>
            {!decisionId && (
              <p className="mt-1 text-sm text-gray-500 dark:text-gray-400">
                No decisions recorded for this finding yet.
              </p>
            )}
            {decisionId && events === null && !eventsError && (
              <p className="mt-1 text-sm text-gray-500 dark:text-gray-400">Loading history…</p>
            )}
            {eventsError && (
              <p className="mt-1 text-sm text-rose-600 dark:text-rose-400">{eventsError}</p>
            )}
            {events && events.length > 0 && (
              <ol className="mt-1 space-y-1">
                {events.map((event) => (
                  <li
                    key={event.id}
                    data-testid="detail-history-event"
                    className="flex flex-wrap items-center gap-2 text-xs text-gray-600 dark:text-gray-300"
                  >
                    <span className="font-medium">
                      {event.beforeState ?? 'created'} → {event.afterState}
                    </span>
                    {event.rationale && <span>“{event.rationale}”</span>}
                    {event.actorLabel && <span>by {event.actorLabel}</span>}
                    {event.createdAt && (
                      <span className="text-gray-400 dark:text-gray-500">{event.createdAt}</span>
                    )}
                  </li>
                ))}
              </ol>
            )}
          </section>
        </div>
      </DialogContent>
    </Dialog>
  );
}
