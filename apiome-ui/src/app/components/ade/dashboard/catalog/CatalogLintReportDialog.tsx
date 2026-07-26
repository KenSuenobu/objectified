'use client';

/**
 * CatalogLintReportDialog (MFI-23.10, #4019).
 *
 * Opens the *same* server-computed lint report the Projects screens use, for a catalog item. A
 * catalog item's id is a project id; the REST endpoint (`GET /api/catalog/{itemId}/lint`) resolves
 * the item's latest revision and lints its canonical model, so the report is populated from the
 * item's own lint/score history rather than browser-local snapshots (which server-side imports never
 * record). The report is fetched lazily — only when the dialog opens — so a list of cards never
 * fans out a request per row.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { LintReportDialog } from '../LintReportDialog';
import {
  fetchCatalogLintReport,
  type VersionLintReport,
} from '../../../../utils/version-lint-report';

interface CatalogLintReportDialogProps {
  /** The catalog item id to lint (a project id), or null when closed. */
  itemId: string | null;
  /** The item name, shown in the dialog title. */
  itemName: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

/**
 * Fetch and render a catalog item's server lint report. Owns the fetch lifecycle (abortable, with a
 * retry affordance) and delegates presentation to the shared {@link LintReportDialog}.
 */
export function CatalogLintReportDialog({
  itemId,
  itemName,
  open,
  onOpenChange,
}: CatalogLintReportDialogProps) {
  // Starts in the loading state: with a per-item `key` on this dialog (set by the parent), a fresh
  // open mounts fresh, so the user sees the spinner — never a stale report or a flash of "error".
  const [report, setReport] = useState<VersionLintReport | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  // The async fetch — only ever calls setState inside its resolution, so it is safe to invoke from
  // an effect (no synchronous cascading renders).
  const load = useCallback(
    (controller: AbortController) =>
      fetchCatalogLintReport(itemId as string, { signal: controller.signal })
        .then((r) => {
          if (!controller.signal.aborted) {
            setReport(r);
            setLoading(false);
          }
        })
        .catch((e: unknown) => {
          if (controller.signal.aborted) return;
          setError(e instanceof Error ? e.message : 'Failed to load lint report');
          setLoading(false);
        }),
    [itemId]
  );

  // Fetch lazily when the dialog opens (and whenever the opened item changes); abort on close.
  useEffect(() => {
    if (!open || !itemId) return;
    const controller = new AbortController();
    abortRef.current = controller;
    void load(controller);
    return () => controller.abort();
  }, [open, itemId, load]);

  // Retry from the error affordance — an event handler, so resetting state synchronously is fine.
  const retry = useCallback(() => {
    if (!itemId) return;
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    setLoading(true);
    setError(null);
    setReport(null);
    void load(controller);
  }, [itemId, load]);

  return (
    <LintReportDialog
      open={open}
      onOpenChange={onOpenChange}
      title={`Quality & Lint report${itemName ? ` — ${itemName}` : ''}`}
      description="Server-computed quality score and itemized findings for this catalog item's latest revision."
      report={report}
      loading={loading}
      error={error}
      onRetry={retry}
      preferCapturedScore
      expanded
    />
  );
}
