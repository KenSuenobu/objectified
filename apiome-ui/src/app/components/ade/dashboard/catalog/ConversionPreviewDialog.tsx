'use client';

/**
 * ConversionPreviewDialog (MFI-22.4, #4005).
 *
 * A *reviewed*-conversion surface for a catalog item: converting a non-OpenAPI source to OpenAPI is
 * lossy, so this dialog makes the trade-off explicit before anything is committed. It reuses the
 * lazy-fetch pattern of {@link CatalogLintReportDialog} (fetch only when open, abortable, with a
 * retry affordance). The fidelity grade + tier header and the **mandatory warning banner** (whose
 * strength scales with the tier: a `low`-tier conversion is acknowledgement-gated — Convert stays
 * disabled until the user explicitly acknowledges) sit above **three tabs**:
 *
 *  - **Summary** — the server's fidelity report (MFI-22.3) as two columns: "What the source
 *    provides" (the constructs that will reach the spec, and how each was derived) and "What
 *    OpenAPI favors but is missing" (the gaps, grouped, with reasons and the enumerated
 *    projection losses), plus the gap-filling defaults form;
 *  - **Projection graph** — the CPDO-3.1 evidence graph with its drawer (CPDO-3.2), fetched
 *    lazily the first time the tab is opened and kept mounted after so the loaded walk and
 *    selection survive tab switches;
 *  - **Conversion** — the raw OpenAPI document the conversion would emit.
 *
 * Optional inline **defaults** (info title/version, servers) let the user close cheap gaps before
 * committing; they flow into the commit request. Approving a defaults change — from the inline
 * form's "Apply & recompute preview" or from the projection evidence drawer's safe-default form
 * (CPDO-3.2, #4802) — re-runs the dry-run and the projection graph **together** with the same
 * defaults (one snapshot, one story) and resets the acknowledgement so its severity is judged
 * against the recomputed report. A collapsible **raw OpenAPI preview** shows the document the
 * conversion would emit. The dry-run itself has no side effects; nothing is created until the
 * user confirms, so Cancel makes no changes.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import dynamic from 'next/dynamic';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from '../../../ui/Dialog';
import { Alert } from '../../../ui/Alert';
import { Badge } from '../../../ui/Badge';
import { Button } from '../../../ui/Button';
import { gradeBand } from '../../../ui/statusVocabulary';
import { cn } from '@lib/utils';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '../../../ui/Tabs';
import {
  cleanDefaults,
  commitConversion,
  coverageLabel,
  coverageTone,
  fetchConversionDryRun,
  partitionChecklist,
  tierBannerVariant,
  tierTone,
  tierWarning,
  type ChecklistItem,
  type ConversionDefaults,
  type ConversionDryRunResult,
  type Loss,
} from '../../../../utils/conversion-fidelity';
import { convertPreviewDialogTitle } from '../../../../utils/catalog-conversion';
import { ConversionProjectionGraphPanel } from './ConversionProjectionGraphPanel';
import { CODE_BLOCK_FONT_SIZE } from '@/app/components/ui/code/editorTypography';

/** Offline fallback when Monaco cannot load — keeps the raw OpenAPI JSON visible.
 * `value` is optional to stay prop-compatible with Monaco's `EditorProps` in the
 * dynamic-import union below. */
function OfflineOpenApiFallback({ value }: { value?: string }) {
  return (
    <pre
      data-testid="conversion-raw-content"
      className="h-full overflow-auto whitespace-pre-wrap break-words p-3 font-mono text-xs leading-5 text-fg"
    >
      {value ?? ''}
    </pre>
  );
}

const MonacoEditor = dynamic(
  () =>
    import('@monaco-editor/react')
      .then((mod) => mod.default)
      .catch(() => OfflineOpenApiFallback),
  {
    ssr: false,
    loading: () => (
      <div className="flex h-full items-center justify-center text-sm text-fg-muted">
        Loading preview…
      </div>
    ),
  },
);

interface ConversionPreviewDialogProps {
  /** The catalog item id to convert (a project id), or null when closed. */
  itemId: string | null;
  /** The item name, shown in the dialog title. */
  itemName: string;
  /** The item's source format (e.g. `graphql`), shown for context. */
  sourceFormat?: string | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Called after a successful commit, with the conversion result, so the parent can refresh. */
  onConverted?: () => void;
}

/** One checklist row rendered as a compact card: construct name, coverage badge, count, reason, examples. */
function ChecklistRow({ item }: { item: ChecklistItem }) {
  return (
    <li className="rounded-md border border-border p-2.5" data-testid="conversion-checklist-row">
      <div className="flex items-center justify-between gap-2">
        <span className="text-sm font-medium text-fg">{item.title}</span>
        <Badge status={coverageTone(item.coverage)} className="shrink-0">
          {coverageLabel(item.coverage)}
          {item.count > 0 ? ` · ${item.count}` : ''}
        </Badge>
      </div>
      <p className="mt-1 text-xs text-fg-muted">{item.reason}</p>
      {item.examples.length > 0 && (
        <p className="mt-1 truncate font-mono text-2xs text-fg-subtle" title={item.examples.join(', ')}>
          {item.examples.join(', ')}
        </p>
      )}
    </li>
  );
}

/** One projection loss rendered as a compact card: subject, kind badge, detail. */
function LossRow({ loss }: { loss: Loss }) {
  return (
    <li className="rounded-md border border-border p-2.5" data-testid="conversion-loss-row">
      <div className="flex items-center justify-between gap-2">
        <span className="font-mono text-xs font-medium text-fg">{loss.subject}</span>
        <Badge
          status={coverageTone(loss.kind === 'n/a' ? 'n/a' : 'inferred')}
          className="shrink-0"
        >
          {loss.kind === 'n/a' ? 'no OpenAPI form' : 'inferred'}
        </Badge>
      </div>
      <p className="mt-1 text-xs text-fg-muted">{loss.detail}</p>
    </li>
  );
}

/**
 * Render the catalog → OpenAPI conversion preview. Owns the dry-run fetch lifecycle and the commit,
 * and gates Convert behind the tier-scaled acknowledgement.
 */
export function ConversionPreviewDialog({
  itemId,
  itemName,
  sourceFormat,
  open,
  onOpenChange,
  onConverted,
}: ConversionPreviewDialogProps) {
  // Starts loading: with a per-item `key` on this dialog (set by the parent) a fresh open mounts
  // fresh, so the user always sees the spinner rather than a stale report.
  const [result, setResult] = useState<ConversionDryRunResult | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [acknowledged, setAcknowledged] = useState(false);
  const [defaults, setDefaults] = useState<ConversionDefaults>({ title: '', version: '', servers: [] });
  const [serversText, setServersText] = useState('');
  /** The defaults the previewed report/graph were computed with (CPDO-3.2); {} initially. */
  const [appliedDefaults, setAppliedDefaults] = useState<ConversionDefaults>({});
  const [recomputing, setRecomputing] = useState(false);
  const [recomputeError, setRecomputeError] = useState<string | null>(null);
  /** The active tab: the summary, the projection graph, or the raw conversion. */
  const [activeTab, setActiveTab] = useState<'summary' | 'projection' | 'conversion'>('summary');
  /**
   * True once the projection tab has been opened. The graph fetches lazily on first open,
   * then stays mounted (hidden) across tab switches so the loaded cursor walk, selection,
   * and drawer survive — switching tabs must not throw evidence away or refetch it.
   */
  const [projectionActivated, setProjectionActivated] = useState(false);
  const [isDark, setIsDark] = useState(false);
  const [committing, setCommitting] = useState(false);
  const [commitError, setCommitError] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  const load = useCallback(
    (controller: AbortController) =>
      fetchConversionDryRun(itemId as string, { signal: controller.signal })
        .then((r) => {
          if (!controller.signal.aborted) {
            setResult(r);
            setLoading(false);
          }
        })
        .catch((e: unknown) => {
          if (controller.signal.aborted) return;
          setError(e instanceof Error ? e.message : 'Failed to preview conversion');
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

  const retry = useCallback(() => {
    if (!itemId) return;
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    setLoading(true);
    setError(null);
    setResult(null);
    setAppliedDefaults({});
    setRecomputeError(null);
    void load(controller);
  }, [itemId, load]);

  /**
   * Recompute the preview with approved defaults (CPDO-3.2): one dry-run whose report,
   * OpenAPI document, and embedded projection summary all describe the same defaults, then
   * — on success only — swap the result in, record the defaults (which restarts the
   * projection graph walk with the same snapshot inputs), sync the inline form, and reset
   * the acknowledgement so its severity is judged against the recomputed report. A failure
   * keeps the previous report/graph/defaults untouched. Nothing persists server-side.
   */
  const recompute = useCallback(
    async (next: ConversionDefaults) => {
      if (!itemId) return;
      const cleaned = cleanDefaults(next);
      abortRef.current?.abort();
      const controller = new AbortController();
      abortRef.current = controller;
      setRecomputing(true);
      setRecomputeError(null);
      try {
        const r = await fetchConversionDryRun(itemId, {
          defaults: cleaned,
          signal: controller.signal,
        });
        if (controller.signal.aborted) return;
        setResult(r);
        setAppliedDefaults(cleaned);
        setDefaults({ title: cleaned.title ?? '', version: cleaned.version ?? '', servers: [] });
        setServersText((cleaned.servers ?? []).join(', '));
        setAcknowledged(false);
      } catch (e: unknown) {
        if (controller.signal.aborted) return;
        setRecomputeError(e instanceof Error ? e.message : 'Failed to recompute the preview');
      } finally {
        if (!controller.signal.aborted) setRecomputing(false);
      }
    },
    [itemId]
  );

  useEffect(() => {
    const sync = () => setIsDark(document.documentElement.classList.contains('dark'));
    sync();
    const observer = new MutationObserver(sync);
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['class'] });
    return () => observer.disconnect();
  }, []);

  const report = result?.report ?? null;
  const openapiJson = useMemo(
    () => (result?.openapi != null ? JSON.stringify(result.openapi, null, 2) : ''),
    [result?.openapi],
  );
  const warning = report ? tierWarning(report.tier) : null;
  const { provided, missing } = useMemo(
    () => (report ? partitionChecklist(report.items) : { provided: [], missing: [] }),
    [report]
  );

  // Convert is blocked while loading/recomputing/committing, on error, and — for a low-tier
  // conversion — until the user acknowledges the incomplete result.
  const ackNeeded = warning?.requiresAck ?? false;
  const convertDisabled =
    loading || recomputing || committing || !report || (ackNeeded && !acknowledged);

  // Whether the inline defaults differ from what the previewed report was computed with —
  // when they do, the truthful next step is recomputing the preview, so the affordance shows.
  const draftDefaults = useMemo(
    () => cleanDefaults({ ...defaults, servers: serversText.split(',') }),
    [defaults, serversText]
  );
  const defaultsDirty = useMemo(
    () => JSON.stringify(draftDefaults) !== JSON.stringify(appliedDefaults),
    [draftDefaults, appliedDefaults]
  );

  const handleConvert = useCallback(async () => {
    if (!itemId) return;
    setCommitting(true);
    setCommitError(null);
    try {
      await commitConversion(itemId, {
        defaults: cleanDefaults({ ...defaults, servers: serversText.split(',') }),
      });
      onConverted?.();
      onOpenChange(false);
    } catch (e: unknown) {
      setCommitError(e instanceof Error ? e.message : 'Failed to convert');
    } finally {
      setCommitting(false);
    }
  }, [itemId, defaults, serversText, onConverted, onOpenChange]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex h-[90vh] max-h-[90vh] max-w-4xl flex-col">
        <DialogHeader>
          <DialogTitle>{convertPreviewDialogTitle(itemName, sourceFormat)}</DialogTitle>
          <DialogDescription>
            Review what the {sourceFormat ? `${sourceFormat} ` : ''}source can and cannot carry onto OpenAPI
            before creating a project. Nothing is created until you convert.
          </DialogDescription>
        </DialogHeader>

        {loading ? (
          <p
            className="py-8 text-center text-sm text-fg-muted"
            data-testid="conversion-preview-loading"
          >
            Analyzing conversion fidelity…
          </p>
        ) : error || !report ? (
          <div className="flex flex-col items-center gap-3 py-8 text-center" data-testid="conversion-preview-error">
            <p className="text-sm text-fg-muted">{error || 'Conversion preview unavailable.'}</p>
            <button
              type="button"
              onClick={retry}
              className="rounded-lg border border-border bg-surface px-3 py-1.5 text-sm font-medium text-fg transition-colors hover:bg-subtle"
            >
              Retry
            </button>
          </div>
        ) : (
          <>
            {/* Header: grade + score + tier + penalty */}
            <div className="flex flex-wrap items-center gap-3">
              {/* The A–F band comes from the shared vocabulary, so this letter is the same
                  colour as the one on the card the click came from. */}
              <span className={cn('cnv-grade', gradeBand(report.grade).solidClass)}>
                {report.grade}
              </span>
              <span className="text-sm text-fg-muted">
                Fidelity <span className="font-semibold">{report.score}</span>/100
              </span>
              <Badge status={tierTone(report.tier)} data-testid="conversion-tier-pill">
                {report.tier} fidelity
              </Badge>
              {report.penalty > 0 && (
                <span className="text-xs text-fg-muted">−{report.penalty} penalty</span>
              )}
            </div>

            {/* Mandatory warning banner — strength scales with tier */}
            {warning && (
              <Alert
                variant={tierBannerVariant(warning.severity)}
                className="mt-3"
                data-testid="conversion-warning-banner"
                data-severity={warning.severity}
              >
                <p className="text-sm font-semibold">{warning.heading}</p>
                <p className="mt-1 text-xs">{warning.body}</p>
              </Alert>
            )}

            {/* Tabbed body: summary / projection graph / conversion. The list stays put;
                each tab's content scrolls. */}
            <Tabs
              value={activeTab}
              onValueChange={(value) => {
                setActiveTab(value as 'summary' | 'projection' | 'conversion');
                if (value === 'projection') setProjectionActivated(true);
              }}
              className="mt-3 flex min-h-0 flex-1 flex-col"
            >
              <TabsList className="w-full">
                <TabsTrigger value="summary" data-testid="conversion-tab-summary">
                  Summary
                </TabsTrigger>
                <TabsTrigger value="projection" data-testid="conversion-tab-projection">
                  Projection graph
                </TabsTrigger>
                <TabsTrigger value="conversion" data-testid="conversion-tab-conversion">
                  Conversion
                </TabsTrigger>
              </TabsList>

              <div className="min-h-0 flex-1 overflow-y-auto pr-1">
                {/* Summary: the fidelity report's two columns + the gap-filling defaults. */}
                <TabsContent value="summary" data-testid="conversion-summary-tab-content">
              <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
                <section data-testid="conversion-provided-column">
                  <h3 className="mb-2 text-sm font-semibold text-fg">
                    What the source provides
                    <span className="ml-1 font-normal text-fg-subtle">({provided.length})</span>
                  </h3>
                  {provided.length === 0 ? (
                    <p className="text-xs text-fg-muted">
                      The source carries nothing directly onto OpenAPI.
                    </p>
                  ) : (
                    <ul className="space-y-2">
                      {provided.map((item) => (
                        <ChecklistRow key={item.key} item={item} />
                      ))}
                    </ul>
                  )}
                </section>

                <section data-testid="conversion-missing-column">
                  <h3 className="mb-2 text-sm font-semibold text-fg">
                    What OpenAPI favors but is missing
                    <span className="ml-1 font-normal text-fg-subtle">
                      ({missing.length + report.losses.length})
                    </span>
                  </h3>
                  {missing.length === 0 && report.losses.length === 0 ? (
                    <p className="text-xs text-fg-muted">
                      No gaps — this source covers the OpenAPI constructs it can.
                    </p>
                  ) : (
                    <ul className="space-y-2">
                      {missing.map((item) => (
                        <ChecklistRow key={item.key} item={item} />
                      ))}
                      {report.losses.map((loss, i) => (
                        <LossRow key={`${loss.kind}:${loss.subject}:${loss.pointer ?? i}`} loss={loss} />
                      ))}
                    </ul>
                  )}
                </section>
              </div>

              {/* Optional inline defaults to close cheap gaps before committing */}
              <section className="mt-4 rounded-lg border border-border p-3">
                <h3 className="text-sm font-semibold text-fg">
                  Fill cheap gaps <span className="font-normal text-fg-subtle">(optional)</span>
                </h3>
                <p className="mt-0.5 text-xs text-fg-muted">
                  Values you supply here flow into the converted spec, closing gaps the source did not carry.
                </p>
                <div className="mt-2 grid grid-cols-1 gap-2 sm:grid-cols-3">
                  <label className="flex flex-col gap-1 text-xs text-fg-muted">
                    Title
                    <input
                      type="text"
                      value={defaults.title ?? ''}
                      onChange={(e) => setDefaults((d) => ({ ...d, title: e.target.value }))}
                      placeholder={itemName}
                      className="rounded-md border border-border-strong bg-surface px-2 py-1 text-sm text-fg"
                      data-testid="conversion-default-title"
                    />
                  </label>
                  <label className="flex flex-col gap-1 text-xs text-fg-muted">
                    Version
                    <input
                      type="text"
                      value={defaults.version ?? ''}
                      onChange={(e) => setDefaults((d) => ({ ...d, version: e.target.value }))}
                      placeholder="1.0.0"
                      className="rounded-md border border-border-strong bg-surface px-2 py-1 text-sm text-fg"
                      data-testid="conversion-default-version"
                    />
                  </label>
                  <label className="flex flex-col gap-1 text-xs text-fg-muted">
                    Servers <span className="text-fg-subtle">(comma-separated)</span>
                    <input
                      type="text"
                      value={serversText}
                      onChange={(e) => setServersText(e.target.value)}
                      placeholder="https://api.example.com"
                      className="rounded-md border border-border-strong bg-surface px-2 py-1 text-sm text-fg"
                      data-testid="conversion-default-servers"
                    />
                  </label>
                </div>
                {/* Approving changed defaults recomputes report + graph together (CPDO-3.2). */}
                {defaultsDirty && (
                  <div className="mt-2 flex flex-wrap items-center gap-2">
                    <button
                      type="button"
                      onClick={() => void recompute({ ...defaults, servers: serversText.split(',') })}
                      disabled={recomputing}
                      data-testid="conversion-defaults-recompute"
                      className="rounded-md border border-accent px-2 py-1 text-xs font-medium text-accent-fg hover:bg-accent-soft disabled:opacity-50"
                    >
                      {recomputing ? 'Recomputing…' : 'Apply & recompute preview'}
                    </button>
                    <span className="text-2xs text-fg-muted">
                      Recomputes the fidelity report and the projection graph together, and asks
                      for acknowledgement again.
                    </span>
                  </div>
                )}
                {recomputeError && (
                  <p
                    className="mt-2 text-xs text-danger"
                    data-testid="conversion-recompute-error"
                  >
                    The preview could not be recomputed — it still shows the previous defaults.{' '}
                    {recomputeError}
                  </p>
                )}
              </section>
                </TabsContent>

                {/* Projection graph (CPDO-3.1/3.2): fetched lazily the first time the tab
                    opens, then kept mounted (hidden) so the loaded cursor walk, selection,
                    and evidence drawer survive tab switches. */}
                {itemId && projectionActivated && (
                  <TabsContent
                    value="projection"
                    forceMount
                    className="data-[state=inactive]:hidden"
                    data-testid="conversion-projection-tab-content"
                  >
                    <ConversionProjectionGraphPanel
                      itemId={itemId}
                      enabled={projectionActivated}
                      envelopeSummary={result?.projection ?? null}
                      report={report}
                      defaults={appliedDefaults}
                      onApplyDefaults={(next) => void recompute(next)}
                      recomputing={recomputing}
                    />
                  </TabsContent>
                )}

                {/* The conversion: the raw OpenAPI document the dry run would emit. */}
                <TabsContent
                  value="conversion"
                  className="mt-0 flex h-full flex-col pt-2"
                  data-testid="conversion-raw-tab-content"
                >
                  {result?.openapi != null ? (
                    <div
                      className="min-h-0 flex-1 overflow-hidden rounded-lg border border-border bg-surface dark:bg-[#1e1e1e]"
                      data-testid="conversion-raw-preview"
                    >
                      <MonacoEditor
                        height="100%"
                        language="json"
                        theme={isDark ? 'vs-dark' : 'light'}
                        value={openapiJson}
                        options={{
                          readOnly: true,
                          domReadOnly: true,
                          minimap: { enabled: false },
                          fontSize: CODE_BLOCK_FONT_SIZE,
                          fontFamily: "'JetBrains Mono', 'Fira Code', Consolas, monospace",
                          lineNumbers: 'on',
                          scrollBeyondLastLine: false,
                          wordWrap: 'off',
                          padding: { top: 12, bottom: 12 },
                          automaticLayout: true,
                          renderLineHighlight: 'none',
                          overviewRulerLanes: 0,
                          hideCursorInOverviewRuler: true,
                          contextmenu: false,
                          links: false,
                          scrollbar: { verticalScrollbarSize: 8, horizontalScrollbarSize: 8 },
                        }}
                      />
                    </div>
                  ) : (
                    <p
                      className="rounded-lg border border-dashed border-border px-3 py-4 text-xs text-fg-subtle"
                      data-testid="conversion-raw-empty"
                    >
                      The dry run returned no OpenAPI document to preview.
                    </p>
                  )}
                </TabsContent>
              </div>
            </Tabs>

            {/* Footer: acknowledgement (low tier) + commit error + actions */}
            <div className="mt-3 border-t border-border pt-3">
              {ackNeeded && warning && (
                <label className="mb-3 flex items-start gap-2 text-sm text-fg">
                  <input
                    type="checkbox"
                    checked={acknowledged}
                    onChange={(e) => setAcknowledged(e.target.checked)}
                    className="mt-0.5 h-4 w-4 rounded border-border-strong text-accent focus:ring-accent"
                    data-testid="conversion-ack"
                  />
                  <span>{warning.ackLabel}</span>
                </label>
              )}
              {commitError && (
                <p className="mb-2 text-sm text-danger" data-testid="conversion-commit-error">
                  {commitError}
                </p>
              )}
              <div className="flex justify-end gap-2">
                <Button variant="outline" onClick={() => onOpenChange(false)} disabled={committing}>
                  Cancel
                </Button>
                <Button
                  variant="default"
                  onClick={handleConvert}
                  disabled={convertDisabled}
                  data-testid="conversion-convert-btn"
                >
                  {committing ? 'Converting…' : 'Convert'}
                </Button>
              </div>
            </div>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}
