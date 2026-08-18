'use client';

import * as React from 'react';
import Link from 'next/link';
import { ArrowUpRight, Check, FileSignature, Lightbulb, ShieldCheck } from 'lucide-react';

import { Alert } from '@/app/components/ui/Alert';
import { Badge } from '@/app/components/ui/Badge';
import { Button } from '@/app/components/ui/Button';
import {
  Drawer,
  DrawerBody,
  DrawerContent,
  DrawerDescription,
  DrawerFooter,
  DrawerHeader,
  DrawerTitle,
} from '@/app/components/ui/Drawer';
import { Skeleton } from '@/app/components/ui/Skeleton';
import { LintReportDialog } from '@/app/components/ade/dashboard/LintReportDialog';
import { LintDecisionBadge } from '@/app/utils/lint-policy-ui';
import {
  fetchVersionLintReport,
  type VersionLintReport,
} from '@/app/utils/version-lint-report';
import type { BulkActionSet, LintWorkspaceFinding } from '@/app/utils/lint-workspace';

import {
  NO_VALUE,
  decisionEventLines,
  decisionEventTone,
  decisionEventsFromPayload,
  findingLocationLine,
  findingPolicyVerdict,
  findingRemediation,
  findingSubjectHref,
  findingSubjectName,
  severityLabel,
  type DecisionEvent,
} from './lintWorkspaceModel';

/**
 * The finding detail drawer — HIVE-5.8 (#5311).
 *
 * Authority: `docs/mockups/govern/lint-posture.html`, the `#finding-drawer` overlay, and
 * DESIGN.md §5.4 ("drawer-first details … lint findings").
 *
 * ### Why this is a drawer and not the dialog it was
 *
 * Triage is a loop: open a finding, read the evidence, decide, move to the next one. A modal
 * dialog covers the queue, so every one of those steps costs the reader their place in a
 * list of two hundred rows. The sheet sits beside the queue, which is the entire reason
 * DESIGN.md names lint findings in its drawer-first list.
 *
 * ### The two verbs in the footer
 *
 * Acknowledge and Request waiver, applied to this one finding — the two decisions a reader
 * is in a position to make having just read the evidence. Everything else stays in the bulk
 * bar, where a decision is made about a *set*. Request waiver opens the same dialog the bulk
 * bar does, because a waiver without a rationale is a waiver the server refuses.
 *
 * ### One departure from the mockup
 *
 * There is no "Open full page ↗" link. DESIGN.md §5.4 asks for one *when a page exists*, and
 * a finding has no page of its own — the subject does, and the Links section is where it is.
 * A link to `#` would be a promise the app cannot keep.
 */

/** Props for {@link LintFindingDrawer}. */
export interface LintFindingDrawerProps {
  /** The finding to show, or `null` when the drawer is closed. */
  finding: LintWorkspaceFinding | null;
  /** Close the drawer. */
  onClose: () => void;
  /** Apply a decision to this one finding. */
  onDecision: (finding: LintWorkspaceFinding, set: BulkActionSet, verbLabel: string) => void;
  /** Open the waiver dialog against this one finding. */
  onRequestWaiver: (finding: LintWorkspaceFinding) => void;
  /** True while a write is in flight. */
  busy?: boolean;
}

/** What the history request is currently holding, keyed by the decision it was made for. */
interface HistoryState {
  forId: string;
  events: DecisionEvent[] | null;
  error: string | null;
}

/**
 * One row of the evidence / links description lists.
 *
 * @param props.term The label.
 * @param props.children The value.
 * @param props.mono Whether the value is an identifier.
 * @returns The `dt`/`dd` pair.
 */
function Row({
  term,
  children,
  mono = false,
}: {
  term: string;
  children: React.ReactNode;
  mono?: boolean;
}) {
  return (
    <>
      <dt>{term}</dt>
      <dd className={mono ? 'mono' : undefined}>{children}</dd>
    </>
  );
}

/**
 * The remediation history, in whichever of its four states it is in.
 *
 * @param props.decisionId The decision whose trail is being read, or `null`.
 * @param props.history What the request is holding.
 * @returns The timeline, or the empty / loading / failed line.
 */
function History({
  decisionId,
  history,
}: {
  decisionId: string | null;
  history: HistoryState | null;
}) {
  const current = history?.forId === decisionId ? history : null;

  if (!decisionId) {
    return (
      <p className="lw-quiet" data-testid="detail-history-empty">
        No decisions recorded for this finding yet.
      </p>
    );
  }
  if (current?.error) {
    return (
      <Alert variant="error" data-testid="detail-history-error">
        Could not load the remediation history. {current.error}
      </Alert>
    );
  }
  if (!current?.events) {
    return (
      <div className="lw-history-skeleton" data-testid="detail-history-loading">
        <Skeleton className="lw-history-skeleton__row" />
        <Skeleton className="lw-history-skeleton__row" />
      </div>
    );
  }
  if (current.events.length === 0) {
    return (
      <p className="lw-quiet" data-testid="detail-history-empty">
        No decisions recorded for this finding yet.
      </p>
    );
  }

  return (
    <ol className="lw-timeline">
      {current.events.map((event) => {
        const lines = decisionEventLines(event);
        return (
          <li
            key={event.id}
            className="lw-timeline__item"
            data-tone={decisionEventTone(event)}
            data-testid="detail-history-event"
          >
            <p className="lw-timeline__title">
              {lines.transition}
              {lines.rationale ? <span className="lw-timeline__why">{lines.rationale}</span> : null}
            </p>
            {lines.meta ? <p className="lw-timeline__meta">{lines.meta}</p> : null}
          </li>
        );
      })}
    </ol>
  );
}

/**
 * The drawer.
 *
 * @param props See {@link LintFindingDrawerProps}.
 * @returns The sheet, and the lint report dialog it can open.
 */
export default function LintFindingDrawer({
  finding,
  onClose,
  onDecision,
  onRequestWaiver,
  busy = false,
}: LintFindingDrawerProps) {
  // Keyed by the decision it was fetched for, so switching findings shows the loading state
  // — a stale entry simply no longer matches — without resetting state inside an effect.
  const [history, setHistory] = React.useState<HistoryState | null>(null);
  const [reportOpen, setReportOpen] = React.useState(false);
  const [report, setReport] = React.useState<VersionLintReport | null>(null);
  const [reportLoading, setReportLoading] = React.useState(false);
  const [reportError, setReportError] = React.useState<string | null>(null);

  const decisionId = finding?.decision?.id ?? null;
  const projectId = finding?.projectId ?? null;
  const versionRecordId = finding?.versionRecordId ?? null;

  React.useEffect(() => {
    if (!decisionId) return;
    const controller = new AbortController();
    fetch(`/api/lint/decisions/${encodeURIComponent(decisionId)}/events`, {
      signal: controller.signal,
      credentials: 'include',
    })
      .then(async (response) => {
        const data = await response.json().catch(() => null);
        if (!response.ok || !data?.success) throw new Error(data?.error || `HTTP ${response.status}`);
        setHistory({ forId: decisionId, events: decisionEventsFromPayload(data.events), error: null });
      })
      .catch((caught: unknown) => {
        if ((caught as Error)?.name === 'AbortError') return;
        setHistory({
          forId: decisionId,
          events: null,
          error: caught instanceof Error ? caught.message : 'Failed to load history',
        });
      });
    return () => controller.abort();
  }, [decisionId]);

  // The report belongs to the *subject*, so it is dropped whenever the drawer moves to a
  // finding on a different revision rather than being shown against the wrong one.
  React.useEffect(() => {
    setReport(null);
    setReportError(null);
    setReportOpen(false);
  }, [projectId, versionRecordId]);

  const loadReport = React.useCallback(() => {
    if (!projectId || !versionRecordId) return;
    setReportLoading(true);
    setReportError(null);
    fetchVersionLintReport(projectId, versionRecordId)
      .then((next) => setReport(next))
      .catch((caught: unknown) =>
        setReportError(caught instanceof Error ? caught.message : 'Failed to load lint report')
      )
      .finally(() => setReportLoading(false));
  }, [projectId, versionRecordId]);

  if (!finding) return null;

  const remediation = findingRemediation(finding);
  const subjectHref = findingSubjectHref(finding);
  const verdict = findingPolicyVerdict(finding);
  const linkedTicket = finding.decision?.linkedTicket ?? null;
  const owner = finding.decision?.ownerUserId ?? null;
  const canOpenReport = Boolean(projectId && versionRecordId);

  return (
    <>
      <Drawer open onOpenChange={(open) => !open && onClose()}>
        <DrawerContent size="lg" data-testid="finding-detail-drawer">
          <DrawerHeader>
            <div className="lw-drawer-head">
              <DrawerTitle className="lw-drawer-title mono">
                {finding.ruleId ?? 'Finding'}
              </DrawerTitle>
              {finding.severity ? (
                <Badge status={finding.severity}>{severityLabel(finding.severity)}</Badge>
              ) : null}
              <LintDecisionBadge state={finding.effectiveState} waived={finding.waived} />
              {finding.isNew ? <Badge status="new">New</Badge> : null}
            </div>
            <DrawerDescription className="lw-drawer-desc">
              {finding.message ?? 'This scanner recorded no message for the finding.'}
            </DrawerDescription>
          </DrawerHeader>

          <DrawerBody className="lw-drawer-body">
            <section data-testid="detail-evidence">
              <h3 className="lw-caps">Evidence</h3>
              <dl className="lw-kv">
                <Row term="Scanner" mono>
                  {finding.scannerId}
                </Row>
                <Row term="Profile">{finding.profile ?? NO_VALUE}</Row>
                <Row term="Evidence run" mono>
                  <span data-testid="detail-evidence-run">{finding.evidenceRunId ?? NO_VALUE}</span>
                </Row>
                <Row term="Recorded">{finding.evidenceCreatedAt ?? NO_VALUE}</Row>
                <Row term="Fingerprint" mono>
                  <span className="lw-fingerprint">{finding.sourceFingerprint ?? NO_VALUE}</span>
                </Row>
                <Row term="Location" mono>
                  <span data-testid="detail-location">{findingLocationLine(finding)}</span>
                </Row>
              </dl>
              {remediation ? (
                <Alert
                  variant="ok"
                  icon={<Lightbulb className="mt-px size-4 shrink-0" aria-hidden />}
                  data-testid="detail-remediation"
                >
                  <span>
                    <strong>Remediation hint.</strong> {remediation}
                  </span>
                </Alert>
              ) : null}
            </section>

            <section data-testid="detail-links">
              <h3 className="lw-caps">Links</h3>
              <dl className="lw-kv">
                <Row term="Subject">
                  {subjectHref ? (
                    <Link href={subjectHref} className="lw-link" data-testid="detail-subject-link">
                      {findingSubjectName(finding)}
                      {finding.subjectLabel && finding.projectName
                        ? ` · ${finding.subjectLabel}`
                        : ''}
                      <ArrowUpRight aria-hidden />
                    </Link>
                  ) : (
                    (finding.subjectLabel ?? NO_VALUE)
                  )}
                </Row>
                <Row term="Policy">
                  <span className="lw-inline" data-testid="detail-policy">
                    <Badge status={verdict.status}>{verdict.label}</Badge>
                    {verdict.evaluationId ? (
                      <span className="lw-quiet">
                        evaluation <span className="mono">{verdict.evaluationId}</span>
                      </span>
                    ) : null}
                  </span>
                </Row>
                <Row term="Ticket">
                  {linkedTicket ? (
                    <a
                      href={linkedTicket}
                      target="_blank"
                      rel="noreferrer"
                      className="lw-link"
                      data-testid="detail-linked-ticket"
                    >
                      {linkedTicket}
                      <ArrowUpRight aria-hidden />
                    </a>
                  ) : (
                    NO_VALUE
                  )}
                </Row>
                <Row term="Owner" mono>
                  {owner ?? NO_VALUE}
                </Row>
              </dl>
            </section>

            <section data-testid="detail-history">
              <div className="lw-section-head">
                <h3 className="lw-caps">Remediation history</h3>
                {canOpenReport ? (
                  <Button
                    variant="link"
                    size="sm"
                    // See the note on the queue's Clear-filters button: the `link` variant's
                    // `--accent` is the fill hue and does not clear AA as 12px text.
                    className="text-accent-fg"
                    data-testid="detail-open-lint-report"
                    onClick={() => {
                      setReportOpen(true);
                      if (!report && !reportLoading) loadReport();
                    }}
                  >
                    <ShieldCheck aria-hidden />
                    Open lint report
                  </Button>
                ) : null}
              </div>
              <History decisionId={decisionId} history={history} />
            </section>
          </DrawerBody>

          <DrawerFooter>
            <Button
              variant="outline"
              disabled={busy}
              data-testid="detail-request-waiver"
              onClick={() => onRequestWaiver(finding)}
            >
              <FileSignature aria-hidden />
              Request waiver
            </Button>
            <Button
              disabled={busy}
              data-testid="detail-acknowledge"
              onClick={() => onDecision(finding, { state: 'acknowledged' }, 'Acknowledge')}
            >
              <Check aria-hidden />
              Acknowledge
            </Button>
          </DrawerFooter>
        </DrawerContent>
      </Drawer>

      <LintReportDialog
        open={reportOpen}
        onOpenChange={setReportOpen}
        title={`Quality & Lint report${finding.subjectLabel ? ` — ${finding.subjectLabel}` : ''}`}
        description="Server-computed quality score and itemized findings for this revision."
        report={report}
        loading={reportLoading}
        error={reportError}
        onRetry={loadReport}
        preferenceView="studio-lint"
      />
    </>
  );
}
