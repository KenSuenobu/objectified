'use client';

/**
 * SchemaVersionScoringPanel — Studio lint panel (GOV-2.4, #4436).
 *
 * The Designer/Studio surface for server-computed quality scoring: grade chip, applied style guide,
 * and itemized violations with rule id, rationale, guide name, and docs links. Also embedded in the
 * post-import report so developers see governance context immediately after import.
 *
 * Re-skinned by HIVE-6.3 (#5314) to `docs/mockups/build/version-dialogs.html` §Lint report &
 * scoring — the *Lint & score* card beside the report dialog, with its guide chip, grade ring,
 * findings list, and the "Lint report unavailable." + Retry pair.
 *
 * The grade chip used to come from `gradeChipClass`, five hand-built Tailwind triples
 * (`bg-emerald-100 text-emerald-800 border-emerald-200` …) that the catalog and export
 * surfaces share. Those callers belong to their own epics, so the helper is left alone; here
 * the chip is a `Badge` taking the shared A–F band from `ui/statusVocabulary`, which is what
 * makes this panel's B the same green as the version row's B two screens away. The error box
 * and its Retry are an `ErrorState`-shaped `Alert` + `Button` rather than a rose-tinted div
 * and a hand-skinned `<button>`.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { RefreshCw } from 'lucide-react';
import { cn } from '@lib/utils';
import { Alert } from '@/app/components/ui/Alert';
import { Badge } from '@/app/components/ui/Badge';
import { Button } from '@/app/components/ui/Button';
import { gradeBand } from '@/app/components/ui/statusVocabulary';
import { VERSION_DIALOG_COPY } from '@/app/components/ade/version-dialogs/versionDialogsModel';
import { fetchVersionLintReport, type VersionLintReport } from '@/app/utils/version-lint-report';
import type { LintViolationDisplayView } from '@/app/utils/lint-violation-display-preferences';
import {
  LintViolationFindingsList,
  lintReportGuideContext,
} from './lint/LintViolationFindingsList';

type PanelStatus = 'idle' | 'loading' | 'loaded' | 'error';

export interface SchemaVersionScoringPanelProps {
  projectId: string;
  versionId: string;
  /** Human-readable version label for the header. */
  versionLabel?: string;
  className?: string;
  /** When false, defer fetching until activated (mirrors catalog lazy tab). */
  active?: boolean;
  /** Which surface's group-by-rule preference to persist (defaults to Studio). */
  preferenceView?: LintViolationDisplayView;
}

/**
 * Fetch and render the authoritative lint report for one project version (Studio / import report).
 */
export function SchemaVersionScoringPanel({
  projectId,
  versionId,
  versionLabel,
  className,
  active = true,
  preferenceView = 'studio-lint',
}: SchemaVersionScoringPanelProps) {
  const [status, setStatus] = useState<PanelStatus>('idle');
  const [report, setReport] = useState<VersionLintReport | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const fetchStartedRef = useRef(false);
  const abortRef = useRef<AbortController | null>(null);

  const loadReport = useCallback(async () => {
    if (!active || fetchStartedRef.current) return;
    fetchStartedRef.current = true;
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    setStatus('loading');
    setErrorMessage(null);
    let loaded: VersionLintReport | null = null;
    let failure: string | null = null;
    try {
      loaded = await fetchVersionLintReport(projectId, versionId, { signal: controller.signal });
    } catch (e) {
      failure = e instanceof Error ? e.message : VERSION_DIALOG_COPY.lintUnavailable;
    } finally {
      if (controller.signal.aborted) {
        /* superseded */
      } else if (failure != null) {
        setErrorMessage(failure);
        setStatus('error');
      } else {
        setReport(loaded);
        setStatus('loaded');
      }
    }
  }, [active, projectId, versionId]);

  useEffect(() => {
    void loadReport();
  }, [loadReport]);

  useEffect(() => () => abortRef.current?.abort(), []);

  const retry = useCallback(() => {
    fetchStartedRef.current = false;
    void loadReport();
  }, [loadReport]);

  const guide = lintReportGuideContext(report);

  return (
    <section
      className={cn('vdlg-panel vdlg-panel--pad vdlg-score', className)}
      data-testid="schema-version-scoring-panel"
    >
      <div className="vdlg-score__head">
        <h2 className="vdlg-caps">
          Lint &amp; score
          {versionLabel ? <span className="vdlg-score__version mono">v{versionLabel}</span> : null}
        </h2>
        {report?.guideName ? (
          <Badge variant="outline" data-testid="studio-lint-guide-name">
            Guide: {report.guideName}
          </Badge>
        ) : null}
      </div>

      {status === 'idle' || status === 'loading' ? (
        <p className="vdlg-quiet" data-testid="studio-lint-loading">
          Loading lint report…
        </p>
      ) : status === 'error' ? (
        <div className="vdlg-score__error" data-testid="studio-lint-error">
          <Alert variant="danger">{errorMessage || VERSION_DIALOG_COPY.lintUnavailable}</Alert>
          <Button type="button" variant="ghost" size="sm" data-testid="studio-lint-retry" onClick={retry}>
            <RefreshCw aria-hidden /> Retry
          </Button>
        </div>
      ) : report ? (
        <>
          <div className="vdlg-score__headline">
            <Badge variant={gradeBand(report.grade).tone} data-testid="studio-lint-grade">
              {report.grade}
            </Badge>
            <span className="vdlg-score__value">
              Score <strong>{report.score}</strong>/100
            </span>
          </div>

          <LintViolationFindingsList
            findings={report.findings}
            guideName={guide.guideName}
            guideId={guide.guideId}
            preferenceView={preferenceView}
          />
        </>
      ) : null}
    </section>
  );
}

export default SchemaVersionScoringPanel;
