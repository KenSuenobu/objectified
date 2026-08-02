'use client';

/**
 * BenchSuitesPanel (IXH-5.7, #5119).
 *
 * Server-persisted test suites for the bench's artifact — the successor to the browser-local
 * saved payloads (which remain, additively): a suite keeps payloads **plus expected verdicts**
 * on the server, runs against any revision, and tracks regressions across runs.
 *
 * Capabilities:
 *  - list this artifact's suites (each with its newest run summary and regression flag);
 *  - create a suite seeded from the current editor payload;
 *  - add the current editor payload to an existing suite (read payload set, append, put back);
 *  - run a suite against the bench's selected version; verdict counts land inline and the
 *    expandable history (`BenchSuiteRunHistory`) shows per-payload diffs;
 *  - export a suite as an IXH-1.1 corpus envelope download and import one back.
 *
 * A payload added from generated content keeps its synthetic label. The expected verdict of a
 * payload added here is `valid` (the corpus `validity_class` vocabulary is fully supported by
 * the API; the panel's quick-add covers the common case).
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import {
  Download,
  FolderPlus,
  History,
  ListPlus,
  Play,
  Trash2,
  TrendingDown,
  Upload,
} from 'lucide-react';
import type { BenchSurface } from '@/app/utils/schema-test-bench';
import {
  nextPayloadName,
  parseSuiteEnvelope,
  serializeSuiteEnvelope,
  suiteRefForSurface,
  verdictToneClass,
  type SchemaTestSuite,
  type SuiteExportEnvelope,
  type SuitePayload,
} from '@/app/utils/schema-test-suites';
import { BenchSuiteRunHistory } from './BenchSuiteRunHistory';

export interface BenchSuitesPanelProps {
  /** Which detail surface hosts the bench. */
  surface: BenchSurface;
  /** Artifact slug (preferred) or id. */
  artifact: string;
  /** The bench's selected version value (a label, revision id, or `latest`). */
  version: string;
  /** Current editor payload, for create/add actions (`''` disables them). */
  payloadText: string;
  /** Whether the current editor payload is synthesized (IXH-5.2). */
  syntheticContent: boolean;
  /** Whether the hosting tab is active; loading is deferred until first activation. */
  active: boolean;
}

const ACTION_CLASS =
  'inline-flex items-center gap-1.5 rounded-lg border border-gray-200 bg-white px-2.5 py-1 text-xs font-medium text-gray-700 transition-colors hover:bg-gray-50 disabled:cursor-not-allowed disabled:opacity-50 dark:border-gray-700 dark:bg-gray-800 dark:text-gray-200 dark:hover:bg-gray-700';

/** Render the suites list and its actions. */
export function BenchSuitesPanel({
  surface,
  artifact,
  version,
  payloadText,
  syntheticContent,
  active,
}: BenchSuitesPanelProps) {
  const stableRef = suiteRefForSurface(surface, artifact);
  const [activated, setActivated] = useState(false);
  const [suites, setSuites] = useState<SchemaTestSuite[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState('');
  const [newSuiteName, setNewSuiteName] = useState('');
  const [busySuiteId, setBusySuiteId] = useState<string | null>(null);
  const [historySuiteId, setHistorySuiteId] = useState<string | null>(null);
  const [historyRefresh, setHistoryRefresh] = useState(0);
  const importInputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    if (active) setActivated(true);
  }, [active]);

  const loadSuites = useCallback(async () => {
    try {
      const res = await fetch(`/api/schemas/suites?ref=${encodeURIComponent(stableRef)}`);
      const data = await res.json();
      if (!res.ok || !data.success) {
        setError(typeof data.error === 'string' ? data.error : 'Could not load test suites.');
        return;
      }
      setError(null);
      setSuites(Array.isArray(data.items) ? data.items : []);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not load test suites.');
    }
  }, [stableRef]);

  useEffect(() => {
    if (!activated) return;
    void loadSuites();
  }, [activated, loadSuites]);

  /** Surface a fault the way the bench does: status line + inline error. */
  const fail = useCallback((data: Record<string, unknown> | null, fallback: string) => {
    const detail = data?.detail;
    const message =
      (typeof detail === 'string' && detail) ||
      (typeof detail === 'object' && detail !== null &&
        typeof (detail as Record<string, unknown>).message === 'string' &&
        ((detail as Record<string, unknown>).message as string)) ||
      (typeof data?.error === 'string' && data.error) ||
      fallback;
    setStatus(message);
  }, []);

  const handleCreate = useCallback(async () => {
    const name = newSuiteName.trim();
    if (!name) return;
    const payloads =
      payloadText.trim() === ''
        ? []
        : [
            {
              name: 'payload 1',
              payload_text: payloadText,
              synthetic: syntheticContent,
            },
          ];
    try {
      const res = await fetch('/api/schemas/suites', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, ref: stableRef, payloads }),
      });
      const data = await res.json();
      if (!res.ok || !data.success) {
        fail(data, 'Could not create the suite.');
        return;
      }
      setNewSuiteName('');
      setStatus(`Created suite "${name}"${payloads.length ? ' with the current payload' : ''}.`);
      await loadSuites();
    } catch (e) {
      setStatus(e instanceof Error ? e.message : 'Could not create the suite.');
    }
  }, [newSuiteName, payloadText, syntheticContent, stableRef, fail, loadSuites]);

  const handleAddPayload = useCallback(
    async (suite: SchemaTestSuite) => {
      if (payloadText.trim() === '') return;
      setBusySuiteId(suite.id);
      try {
        const detailRes = await fetch(`/api/schemas/suites/${encodeURIComponent(suite.id)}`);
        const detail = await detailRes.json();
        if (!detailRes.ok || !detail.success) {
          fail(detail, 'Could not load the suite.');
          return;
        }
        const existing: SuitePayload[] = Array.isArray(detail.payloads) ? detail.payloads : [];
        const appended = [
          ...existing,
          {
            name: nextPayloadName(existing),
            payload_text: payloadText,
            synthetic: syntheticContent,
          },
        ];
        const res = await fetch(`/api/schemas/suites/${encodeURIComponent(suite.id)}/payloads`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ payloads: appended }),
        });
        const data = await res.json();
        if (!res.ok || !data.success) {
          fail(data, 'Could not add the payload.');
          return;
        }
        setStatus(`Added the current payload to "${suite.name}".`);
        await loadSuites();
      } catch (e) {
        setStatus(e instanceof Error ? e.message : 'Could not add the payload.');
      } finally {
        setBusySuiteId(null);
      }
    },
    [payloadText, syntheticContent, fail, loadSuites]
  );

  const handleRun = useCallback(
    async (suite: SchemaTestSuite) => {
      setBusySuiteId(suite.id);
      setStatus(`Running "${suite.name}"…`);
      try {
        const res = await fetch(`/api/schemas/suites/${encodeURIComponent(suite.id)}/runs`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ version }),
        });
        const data = await res.json();
        if (!res.ok || !data.success) {
          fail(data, 'The run failed.');
          return;
        }
        setStatus(
          data.status === 'error'
            ? `"${suite.name}" could not run: ${data.message ?? 'the reference did not resolve.'}`
            : data.regression
              ? `"${suite.name}": ${data.passed}/${data.total} passed — regression detected.`
              : `"${suite.name}": ${data.passed}/${data.total} passed.`
        );
        setHistoryRefresh((token) => token + 1);
        await loadSuites();
      } catch (e) {
        setStatus(e instanceof Error ? e.message : 'The run failed.');
      } finally {
        setBusySuiteId(null);
      }
    },
    [version, fail, loadSuites]
  );

  const handleDelete = useCallback(
    async (suite: SchemaTestSuite) => {
      setBusySuiteId(suite.id);
      try {
        const res = await fetch(`/api/schemas/suites/${encodeURIComponent(suite.id)}`, {
          method: 'DELETE',
        });
        const data = await res.json().catch(() => null);
        if (!res.ok || !data?.success) {
          fail(data, 'Could not delete the suite.');
          return;
        }
        if (historySuiteId === suite.id) setHistorySuiteId(null);
        setStatus(`Deleted suite "${suite.name}".`);
        await loadSuites();
      } catch (e) {
        setStatus(e instanceof Error ? e.message : 'Could not delete the suite.');
      } finally {
        setBusySuiteId(null);
      }
    },
    [historySuiteId, fail, loadSuites]
  );

  const handleExport = useCallback(
    async (suite: SchemaTestSuite) => {
      try {
        const res = await fetch(`/api/schemas/suites/${encodeURIComponent(suite.id)}/export`);
        const data = await res.json();
        if (!res.ok || !data.success) {
          fail(data, 'Could not export the suite.');
          return;
        }
        const envelope: SuiteExportEnvelope = { manifest: data.manifest, files: data.files };
        const blob = new Blob([serializeSuiteEnvelope(envelope)], { type: 'application/json' });
        const url = URL.createObjectURL(blob);
        const anchor = document.createElement('a');
        anchor.href = url;
        anchor.download = `${suite.name.replace(/[^a-z0-9]+/gi, '-').toLowerCase()}-suite.json`;
        anchor.click();
        URL.revokeObjectURL(url);
        setStatus(
          `Exported "${suite.name}" as a corpus envelope — materialize its files next to a ` +
            'manifest.json to run it with `apiome schema test --suite`.'
        );
      } catch (e) {
        setStatus(e instanceof Error ? e.message : 'Could not export the suite.');
      }
    },
    [fail]
  );

  const handleImportFile = useCallback(
    async (file: File) => {
      const text = await file.text();
      const parsed = parseSuiteEnvelope(text);
      if ('error' in parsed) {
        setStatus(parsed.error);
        return;
      }
      const stem = file.name.replace(/\.json$/i, '').trim() || 'imported suite';
      try {
        const res = await fetch('/api/schemas/suites/import', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            name: stem,
            ref: stableRef,
            manifest: parsed.envelope.manifest,
            files: parsed.envelope.files,
          }),
        });
        const data = await res.json();
        if (!res.ok || !data.success) {
          fail(data, 'Could not import the suite.');
          return;
        }
        setStatus(`Imported suite "${stem}" (${data.payload_count} payloads).`);
        await loadSuites();
      } catch (e) {
        setStatus(e instanceof Error ? e.message : 'Could not import the suite.');
      }
    },
    [stableRef, fail, loadSuites]
  );

  return (
    <section className="space-y-3" aria-label="Test suites" data-testid="bench-suites-panel">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="text-xs font-semibold uppercase tracking-wider text-gray-500 dark:text-gray-400">
          Test suites
        </h3>
        <button
          type="button"
          data-testid="suite-import"
          onClick={() => importInputRef.current?.click()}
          className={ACTION_CLASS}
          title="Import a suite from an exported corpus envelope (manifest + files JSON)."
        >
          <Upload className="h-3.5 w-3.5 text-gray-500" aria-hidden /> Import
        </button>
        <input
          ref={importInputRef}
          data-testid="suite-import-input"
          type="file"
          accept="application/json,.json"
          aria-label="Import suite envelope file"
          className="hidden"
          onChange={(event) => {
            const file = event.target.files?.[0];
            event.target.value = '';
            if (file) void handleImportFile(file);
          }}
        />
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <input
          data-testid="suite-create-name"
          type="text"
          value={newSuiteName}
          onChange={(event) => setNewSuiteName(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter') {
              event.preventDefault();
              void handleCreate();
            }
          }}
          placeholder="e.g. order payload regression suite"
          aria-label="New suite name"
          className="w-64 rounded-lg border border-gray-200 bg-white px-3 py-1.5 text-sm text-gray-900 focus:outline-none focus:ring-2 focus:ring-indigo-500 dark:border-gray-700 dark:bg-gray-900 dark:text-white"
        />
        <button
          type="button"
          data-testid="suite-create"
          onClick={() => void handleCreate()}
          disabled={newSuiteName.trim() === ''}
          className={ACTION_CLASS}
          title="Create a suite for this artifact, seeded with the current payload when one is present."
        >
          <FolderPlus className="h-3.5 w-3.5 text-indigo-500" aria-hidden /> New suite
        </button>
      </div>

      {error ? (
        <p data-testid="suites-error" className="text-xs text-amber-700 dark:text-amber-300">
          {error}
        </p>
      ) : null}

      {suites.length > 0 ? (
        <ul data-testid="suites-list" className="space-y-1">
          {suites.map((suite) => {
            const latest = suite.latest_run;
            const busy = busySuiteId === suite.id;
            return (
              <li
                key={suite.id}
                className="space-y-1.5 rounded-md border border-gray-100 px-2 py-1.5 dark:border-gray-800"
              >
                <div className="flex flex-wrap items-center gap-2">
                  <span className="min-w-0 flex-1 truncate text-sm text-gray-800 dark:text-gray-100">
                    {suite.name}
                  </span>
                  <span className="shrink-0 text-[10px] tabular-nums text-gray-400 dark:text-gray-500">
                    {suite.payload_count} payloads · v{suite.suite_version}
                  </span>
                  {latest ? (
                    latest.status === 'error' ? (
                      <span
                        className={`rounded px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wider ${verdictToneClass('error')}`}
                      >
                        last run errored
                      </span>
                    ) : (
                      <span
                        data-testid={`suite-latest-${suite.id}`}
                        className="tabular-nums text-[11px] text-gray-500 dark:text-gray-400"
                      >
                        {latest.passed}/{latest.total} passed
                        {latest.resolved_version_label ? ` @ ${latest.resolved_version_label}` : ''}
                      </span>
                    )
                  ) : (
                    <span className="text-[11px] text-gray-400 dark:text-gray-500">never run</span>
                  )}
                  {latest?.regression ? (
                    <span
                      data-testid={`suite-regression-${suite.id}`}
                      className={`inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wider ${verdictToneClass('failed')}`}
                    >
                      <TrendingDown className="h-3 w-3" aria-hidden /> regression
                    </span>
                  ) : null}
                </div>
                <div className="flex flex-wrap items-center gap-1.5">
                  <button
                    type="button"
                    data-testid={`suite-run-${suite.id}`}
                    onClick={() => void handleRun(suite)}
                    disabled={busy || suite.payload_count === 0}
                    className={ACTION_CLASS}
                    title={
                      suite.payload_count === 0
                        ? 'Add a payload first — an empty suite has nothing to run.'
                        : `Run every payload against the selected version (${version}).`
                    }
                  >
                    <Play className="h-3.5 w-3.5 text-indigo-500" aria-hidden />
                    {busy ? 'Working…' : 'Run'}
                  </button>
                  <button
                    type="button"
                    data-testid={`suite-add-payload-${suite.id}`}
                    onClick={() => void handleAddPayload(suite)}
                    disabled={busy || payloadText.trim() === ''}
                    className={ACTION_CLASS}
                    title="Add the current editor payload to this suite (expected verdict: valid)."
                  >
                    <ListPlus className="h-3.5 w-3.5 text-gray-500" aria-hidden /> Add payload
                  </button>
                  <button
                    type="button"
                    data-testid={`suite-history-${suite.id}`}
                    onClick={() =>
                      setHistorySuiteId((current) => (current === suite.id ? null : suite.id))
                    }
                    aria-expanded={historySuiteId === suite.id}
                    className={ACTION_CLASS}
                  >
                    <History className="h-3.5 w-3.5 text-gray-500" aria-hidden /> History
                  </button>
                  <button
                    type="button"
                    data-testid={`suite-export-${suite.id}`}
                    onClick={() => void handleExport(suite)}
                    className={ACTION_CLASS}
                    title="Download the suite as an IXH-1.1 corpus envelope (manifest + files)."
                  >
                    <Download className="h-3.5 w-3.5 text-gray-500" aria-hidden /> Export
                  </button>
                  <button
                    type="button"
                    data-testid={`suite-delete-${suite.id}`}
                    onClick={() => void handleDelete(suite)}
                    disabled={busy}
                    className="shrink-0 rounded p-1 text-gray-400 hover:bg-rose-50 hover:text-rose-600 focus:outline-none focus:ring-2 focus:ring-indigo-500 dark:hover:bg-rose-950/40"
                    aria-label={`Delete suite ${suite.name}`}
                  >
                    <Trash2 className="h-3.5 w-3.5" aria-hidden />
                  </button>
                </div>
                {historySuiteId === suite.id ? (
                  <BenchSuiteRunHistory suiteId={suite.id} refreshToken={historyRefresh} />
                ) : null}
              </li>
            );
          })}
        </ul>
      ) : (
        <p className="text-xs text-gray-500 dark:text-gray-400" data-testid="suites-empty">
          No test suites for this artifact yet — save the payloads that prove this schema works,
          and every future revision can be checked against them.
        </p>
      )}

      {/* Screen-reader-audible progress feedback, mirroring the bench's status line. */}
      <p data-testid="suites-status-live" aria-live="polite" className="sr-only">
        {status}
      </p>
    </section>
  );
}
