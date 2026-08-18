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
  verdictTone,
  type SchemaTestSuite,
  type SuiteExportEnvelope,
  type SuitePayload,
} from '@/app/utils/schema-test-suites';
import { Badge } from '@/app/components/ui/Badge';
import { Button } from '@/app/components/ui/Button';
import { Input } from '@/app/components/ui/Input';
import { VERSION_DIALOG_COPY } from '@/app/components/ade/version-dialogs/versionDialogsModel';
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
    <section className="vdlg-stack" aria-label="Test suites" data-testid="bench-suites-panel">
      <div className="vdlg-bench__row vdlg-bench__row--between">
        <h3 className="vdlg-caps">Test suites</h3>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          data-testid="suite-import"
          onClick={() => importInputRef.current?.click()}
          title="Import a suite from an exported corpus envelope (manifest + files JSON)."
        >
          <Upload aria-hidden /> Import
        </Button>
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

      <div className="vdlg-bench__row">
        <Input
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
          className="vdlg-bench__name-input"
        />
        <Button
          type="button"
          variant="outline"
          size="sm"
          data-testid="suite-create"
          onClick={() => void handleCreate()}
          disabled={newSuiteName.trim() === ''}
          title="Create a suite for this artifact, seeded with the current payload when one is present."
        >
          <FolderPlus aria-hidden /> New suite
        </Button>
      </div>

      {error ? (
        <p data-testid="suites-error" className="vdlg-bench__status" data-tone="warn">
          {error}
        </p>
      ) : null}

      {suites.length > 0 ? (
        <ul data-testid="suites-list" className="vdlg-bench__list">
          {suites.map((suite) => {
            const latest = suite.latest_run;
            const busy = busySuiteId === suite.id;
            return (
              <li key={suite.id} className="vdlg-bench__suite">
                <div className="vdlg-bench__suite-head">
                  <span className="vdlg-bench__suite-name">{suite.name}</span>
                  <span className="vdlg-bench__list-date">
                    {suite.payload_count} payloads · v{suite.suite_version}
                  </span>
                  {latest ? (
                    latest.status === 'error' ? (
                      <Badge variant={verdictTone('error')}>last run errored</Badge>
                    ) : (
                      <span data-testid={`suite-latest-${suite.id}`} className="vdlg-bench__run-count">
                        {latest.passed}/{latest.total} passed
                        {latest.resolved_version_label ? ` @ ${latest.resolved_version_label}` : ''}
                      </span>
                    )
                  ) : (
                    <span className="vdlg-quiet">never run</span>
                  )}
                  {latest?.regression ? (
                    <Badge variant={verdictTone('failed')} data-testid={`suite-regression-${suite.id}`}>
                      <TrendingDown aria-hidden /> regression
                    </Badge>
                  ) : null}
                </div>
                <div className="vdlg-button-row">
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    data-testid={`suite-run-${suite.id}`}
                    onClick={() => void handleRun(suite)}
                    disabled={busy || suite.payload_count === 0}
                    title={
                      suite.payload_count === 0
                        ? 'Add a payload first — an empty suite has nothing to run.'
                        : `Run every payload against the selected version (${version}).`
                    }
                  >
                    <Play aria-hidden />
                    {busy ? 'Working…' : 'Run'}
                  </Button>
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    data-testid={`suite-add-payload-${suite.id}`}
                    onClick={() => void handleAddPayload(suite)}
                    disabled={busy || payloadText.trim() === ''}
                    title="Add the current editor payload to this suite (expected verdict: valid)."
                  >
                    <ListPlus aria-hidden /> Add payload
                  </Button>
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    data-testid={`suite-history-${suite.id}`}
                    onClick={() =>
                      setHistorySuiteId((current) => (current === suite.id ? null : suite.id))
                    }
                    aria-expanded={historySuiteId === suite.id}
                  >
                    <History aria-hidden /> History
                  </Button>
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    data-testid={`suite-export-${suite.id}`}
                    onClick={() => void handleExport(suite)}
                    title="Download the suite as an IXH-1.1 corpus envelope (manifest + files)."
                  >
                    <Download aria-hidden /> Export
                  </Button>
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    data-testid={`suite-delete-${suite.id}`}
                    onClick={() => void handleDelete(suite)}
                    disabled={busy}
                    aria-label={`Delete suite ${suite.name}`}
                  >
                    <Trash2 className="vdlg-icon-danger" aria-hidden />
                  </Button>
                </div>
                {historySuiteId === suite.id ? (
                  <BenchSuiteRunHistory suiteId={suite.id} refreshToken={historyRefresh} />
                ) : null}
              </li>
            );
          })}
        </ul>
      ) : (
        <p className="vdlg-quiet" data-testid="suites-empty">
          {VERSION_DIALOG_COPY.benchNoSuites}
        </p>
      )}

      {/* Screen-reader-audible progress feedback, mirroring the bench's status line. */}
      <p data-testid="suites-status-live" aria-live="polite" className="sr-only">
        {status}
      </p>
    </section>
  );
}
