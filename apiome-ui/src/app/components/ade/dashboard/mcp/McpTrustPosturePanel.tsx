'use client';

/**
 * MCP trust-posture panel (CLX-3.2, #4856).
 *
 * Renders a snapshot's source / supply-chain / trust-posture report: findings grouped by OWASP MCP
 * risk, each tagged with its evidence origin (metadata / source / dependency), the coverage gaps
 * where a rule could not be evaluated, and the gate decision.
 *
 * The panel's defining responsibility is honesty about what the scan does and does not know:
 *
 * - A prominent banner states that **every finding is a signal, not a demonstrated exploit** — for
 *   exactly as long as that is true. It is driven by the report's own `provenCount`, so the day a
 *   dynamic probe (CLX-3.3, #4857) proves something, the banner changes on its own.
 * - Each finding carries an explicit "Signal — not proven exploitable" label, never a bare red chip.
 * - Skipped rules are shown as visible coverage gaps, so an unscanned lane never reads as clean.
 *
 * ### Where it is mounted (HIVE-7.8, #5325)
 *
 * Nowhere, until this ticket. The component, its API route and its test suite have existed since
 * CLX-3.2 (#4856) and no screen rendered them. `docs/mockups/sources/mcp-endpoint.html` proposes a
 * home — a sixth tab on the endpoint detail, beside Lint & score — and marks it **Proposed** in
 * honey so the fact that it is a proposal rather than a shipped decision stays on the screen. That
 * is what {@link McpEndpointTabList} draws and what this panel now fills.
 *
 * The re-skin that came with it: the honesty banner was `border-sky-200 bg-sky-50 text-sky-900
 * dark:…` (a hand-rolled `ui/Alert`), each section was a `dashboardPanelPaddedClass` div, and the
 * severity and origin chips were six pairs of palette classes. All tokens now — see
 * `utils/mcp-trust-posture` for the two chip helpers.
 */

import * as React from 'react';
import { Info } from 'lucide-react';
import { Alert } from '@/app/components/ui/Alert';
import { Badge } from '@/app/components/ui/Badge';
import { Card, CardBody, CardHeader, CardTitle } from '@/app/components/ui/Card';
import { LoadingState } from '@/app/components/ui/LoadingState';
import { EmptyState } from '@/app/components/ui/EmptyState';
import {
  fetchPostureReport,
  groupFindingsByOwasp,
  hasProvenFindings,
  postureOriginTone,
  postureSeverityTone,
  type PostureReport,
} from '@/app/utils/mcp-trust-posture';

export type McpTrustPosturePanelProps = {
  endpointId: string;
  versionId: string;
  profile?: string;
};

export function McpTrustPosturePanel({ endpointId, versionId, profile }: McpTrustPosturePanelProps) {
  const [report, setReport] = React.useState<PostureReport | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [loading, setLoading] = React.useState(false);

  React.useEffect(() => {
    if (!endpointId || !versionId) return;
    let cancelled = false;
    const controller = new AbortController();
    setLoading(true);
    setError(null);
    void (async () => {
      try {
        const result = await fetchPostureReport(endpointId, versionId, {
          profile,
          signal: controller.signal,
        });
        if (!cancelled) setReport(result);
      } catch (e) {
        if (cancelled || controller.signal.aborted) return;
        setError(e instanceof Error ? e.message : 'Failed to load trust posture.');
        setReport(null);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [endpointId, versionId, profile]);

  if (loading) return <LoadingState message="Loading trust posture…" />;
  if (error) {
    return (
      <EmptyState
        tone="danger"
        title="Trust posture unavailable"
        description={error}
        data-testid="mcp-posture-error"
      />
    );
  }
  if (!report) return null;

  const groups = groupFindingsByOwasp(report.findings);
  const proven = hasProvenFindings(report);

  return (
    <div className="flex flex-col gap-4" data-testid="mcp-trust-posture">
      {/* The honesty banner. Present for as long as nothing has been proven — driven by the
          report, not hard-coded, so it retires itself when CLX-3.3's probes arrive. */}
      {!proven ? (
        <Alert variant="info" icon={<Info aria-hidden className="mt-px size-4 shrink-0" />}>
          Every finding below is a <strong>signal to review</strong>, not a demonstrated exploit.
          Static analysis can indicate risk; it cannot prove a server is exploitable. Confirmation
          requires a dynamic probe.
        </Alert>
      ) : null}

      <Card>
        <CardHeader className="flex-row flex-wrap items-center gap-3">
          <div className="min-w-0">
            <CardTitle>Trust posture</CardTitle>
            <p className="mt-1 text-sm text-fg-muted">
              Profile {report.profile} · OWASP MCP {report.owaspRevision} · score {report.score}/100
              (grade {report.grade})
            </p>
          </div>
          <Badge
            className="ml-auto"
            status={report.gate.passed ? 'passed' : 'failed'}
            title="Gate decision"
          >
            Gate {report.gate.passed ? 'passed' : 'failed'}
          </Badge>
        </CardHeader>
        {report.gate.reasons.length > 0 ? (
          <CardBody>
            <ul className="list-disc space-y-1 pl-5 text-sm text-fg-muted">
              {report.gate.reasons.map((reason) => (
                <li key={reason}>{reason}</li>
              ))}
            </ul>
          </CardBody>
        ) : null}
      </Card>

      {groups.length === 0 ? (
        <EmptyState
          title="No trust-posture findings"
          description="No signals were raised by the rules that could be evaluated for this snapshot."
          data-testid="mcp-posture-clean"
        />
      ) : (
        groups.map(({ riskId, findings }) => (
          <Card key={riskId} data-testid={`mcp-posture-risk-${riskId}`}>
            <CardHeader className="flex-row items-center gap-2">
              <CardTitle className="text-sm">{riskId}</CardTitle>
              <span className="ml-auto text-xs text-fg-muted">
                {findings.length} finding{findings.length === 1 ? '' : 's'}
              </span>
            </CardHeader>
            <CardBody>
              <ul className="flex flex-col gap-3">
                {findings.map((finding) => (
                  <li key={finding.id} className="mcp-posture__finding">
                    <div className="mcp-posture__head">
                      <Badge variant={postureSeverityTone(finding.severity)}>
                        {finding.severity}
                      </Badge>
                      <Badge
                        variant={postureOriginTone(finding.origin)}
                        title="Which evidence lane this came from"
                      >
                        {finding.originLabel || finding.origin}
                      </Badge>
                      {/* Never omitted — it is the honesty guarantee. */}
                      <Badge
                        variant="outline"
                        title="Static findings are signals, not demonstrated exploits"
                      >
                        {finding.exploitabilityLabel}
                      </Badge>
                      <code className="mono text-xs text-fg-muted">{finding.path}</code>
                    </div>
                    <p className="mcp-posture__message">{finding.message}</p>
                    {finding.excerpt ? (
                      <pre className="mt-2 overflow-x-auto rounded-sm bg-inset p-2 text-xs text-fg-muted">
                        {finding.excerpt}
                      </pre>
                    ) : null}
                    {finding.remediation ? (
                      <p className="mcp-posture__remediation">
                        <strong className="text-fg">Remediation:</strong> {finding.remediation}
                      </p>
                    ) : null}
                  </li>
                ))}
              </ul>
            </CardBody>
          </Card>
        ))
      )}

      {/* Coverage gaps. Shown, not hidden: a rule with no evidence was not evaluated, and that
          is a different thing from a rule that passed. */}
      <div className="mcp-posture__coverage">
        {report.skippedRules.length > 0 ? (
          <Card variant="soft" data-testid="mcp-posture-skipped">
            <CardBody>
              <h4 className="text-sm font-semibold text-fg">
                Not evaluated ({report.skippedRules.length})
              </h4>
              <p className="mt-1 text-sm text-fg-muted">
                These rules could not run for lack of evidence. They are <strong>not
                passing</strong> — they are unverified.
              </p>
              <ul className="mt-2 space-y-1 text-sm text-fg-muted">
                {report.skippedRules.map((ruleId) => (
                  <li key={ruleId}>
                    <code className="mono text-xs">{ruleId}</code>
                    {report.skipReasons[ruleId] ? ` — ${report.skipReasons[ruleId]}` : null}
                  </li>
                ))}
              </ul>
            </CardBody>
          </Card>
        ) : null}

        {report.owaspCoverage.uncovered.length > 0 ? (
          <Card variant="soft" data-testid="mcp-posture-coverage">
            <CardBody>
              <h4 className="text-sm font-semibold text-fg">OWASP coverage</h4>
              <p className="mt-1 text-sm text-fg-muted">
                The evaluated rules do not cover these OWASP MCP risks. An unmentioned risk is not
                an absent one — it is one this scan cannot speak to:{' '}
                <span className="font-medium text-fg">
                  {report.owaspCoverage.uncovered.join(', ')}
                </span>
                .
              </p>
            </CardBody>
          </Card>
        ) : null}
      </div>
    </div>
  );
}
