'use client';

/**
 * SchemaTestBench (IXH-5.3, #5115).
 *
 * The Test Bench panel mounted as a tab on catalog item detail and project version detail:
 * pick a schema (operation request/response body, component schema, registry type), paste or
 * generate a payload, validate it against the IXH-5.1 endpoint, and read the result as inline
 * editor markers plus a path-anchored findings list.
 *
 * Data flow:
 *  - `/api/schemas/targets?ref={surface}/{artifact}/{version}` fills the picker's operation
 *    bodies + component schemas (IXH-5.3 REST listing); `/api/primitives` fills its registry
 *    types; both load lazily on first activation.
 *  - **Validate** posts the editor text to `/api/schemas/validate`; findings are anchored onto
 *    the payload via `jsonPointerRanges` (inline markers + clickable rows).
 *  - **Generate** posts to `/api/schemas/synthesize` (IXH-5.2); every returned instance is
 *    loadable in one click and stays labelled synthetic in the editor and on save.
 *  - Saved payloads are browser-local, scoped tenant + schema reference.
 *  - **Copy as curl** exports the current payload as a REST call (`$APIOME_API_KEY` auth,
 *    never an embedded credential); **Copy as fixture** exports a payload that just validated
 *    as an IXH-1.1 corpus manifest entry, so a validated payload becomes a corpus entry.
 *
 * Bounds (IXH-3.6): payloads above `TEST_BENCH_PAYLOAD_MAX_BYTES` are refused with a stated
 * size; findings request `TEST_BENCH_MAX_FINDINGS` and any server truncation is stated; the
 * findings list windows above `TEST_BENCH_FINDINGS_VIRTUALIZE_ABOVE` rows.
 */

import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import { FlaskConical, Play, Terminal, PackagePlus } from 'lucide-react';
import { dashboardPanelClass } from '@/app/components/ade/dashboard/dashboardScreenClasses';
import {
  TEST_BENCH_MAX_FINDINGS,
  TEST_BENCH_PAYLOAD_MAX_BYTES,
} from '@/app/utils/preview-budgets';
import {
  buildCorpusFixture,
  buildCurlCommand,
  buildSchemaRef,
  checkPayloadBudget,
  findingsToMarkers,
  jsonPointerRanges,
  registryRefFromPrimitive,
  type BenchFinding,
  type BenchMarker,
  type BenchSchemaSelection,
  type BenchSynthesisPayload,
  type BenchSynthesizedInstance,
  type BenchValidationPayload,
  type BenchSurface,
  type SchemaTargetsPayload,
} from '@/app/utils/schema-test-bench';
import {
  deleteBenchPayload,
  loadSavedBenchPayloads,
  saveBenchPayload,
  type SavedBenchPayload,
} from '@/app/utils/schema-test-bench-saved-payloads';
import { SchemaTargetPicker, type RegistryTargetOption } from './SchemaTargetPicker';
import { BenchPayloadEditor, type BenchPayloadEditorHandle } from './BenchPayloadEditor';
import { BenchFindingsList } from './BenchFindingsList';
import { BenchGeneratedPanel } from './BenchGeneratedPanel';
import { BenchSavedPayloads } from './BenchSavedPayloads';
import { BenchSuitesPanel } from './BenchSuitesPanel';

const REST_API_BASE_URL = process.env.NEXT_PUBLIC_REST_API_BASE_URL || 'http://localhost:8000/v1';

/** A version the bench can address (label shown, value used in the reference). */
export interface BenchVersionOption {
  value: string;
  label: string;
}

export interface SchemaTestBenchProps {
  /** Which detail surface hosts the bench. */
  surface: BenchSurface;
  /** Artifact slug (preferred) or id. */
  artifact: string;
  /** Human name, for headings. */
  artifactName: string;
  /** Addressable versions; defaults to just `latest`. */
  versionOptions?: BenchVersionOption[];
  /** Initially selected version value; defaults to the first option. */
  initialVersion?: string;
  /** Current tenant id, for saved-payload scoping (`null` disables saving). */
  tenantId: string | null;
  /** Whether the hosting tab is active; loading is deferred until first activation. */
  active: boolean;
}

const DEFAULT_VERSIONS: BenchVersionOption[] = [{ value: 'latest', label: 'Latest revision' }];

/** A minimal primitive row as returned by `/api/primitives`. */
interface PrimitiveRow {
  id?: string;
  name?: string;
  namespace?: string | null;
  schema_id?: string | null;
}

/**
 * Render the Test Bench panel. All server data loads lazily on first activation so mounting
 * the (hidden) tab costs nothing.
 */
export function SchemaTestBench({
  surface,
  artifact,
  artifactName,
  versionOptions,
  initialVersion,
  tenantId,
  active,
}: SchemaTestBenchProps) {
  const versions = versionOptions && versionOptions.length > 0 ? versionOptions : DEFAULT_VERSIONS;
  const versionSelectId = useId();
  const [version, setVersion] = useState(initialVersion ?? versions[0].value);
  const [activated, setActivated] = useState(false);

  // --- Picker data -----------------------------------------------------------------------
  const [targets, setTargets] = useState<SchemaTargetsPayload | null>(null);
  const [targetsError, setTargetsError] = useState<string | null>(null);
  const [targetsLoading, setTargetsLoading] = useState(false);
  const [registryTypes, setRegistryTypes] = useState<RegistryTargetOption[]>([]);

  // --- Selection + editor ----------------------------------------------------------------
  const [selection, setSelection] = useState<BenchSchemaSelection | null>(null);
  const [payloadText, setPayloadText] = useState('');
  const [syntheticContent, setSyntheticContent] = useState(false);
  const editorRef = useRef<BenchPayloadEditorHandle | null>(null);

  // --- Results ---------------------------------------------------------------------------
  const [validation, setValidation] = useState<BenchValidationPayload | null>(null);
  const [markers, setMarkers] = useState<BenchMarker[]>([]);
  const [validating, setValidating] = useState(false);
  /** The exact text the last passing validation ran over — gates the fixture export. */
  const [validatedText, setValidatedText] = useState<string | null>(null);
  const [synthesis, setSynthesis] = useState<BenchSynthesisPayload | null>(null);
  const [generating, setGenerating] = useState(false);

  // --- Saved payloads + status line ------------------------------------------------------
  const [savedPayloads, setSavedPayloads] = useState<SavedBenchPayload[]>([]);
  const [status, setStatus] = useState('');

  const revisionRef = useMemo(
    () => buildSchemaRef(surface, artifact, version),
    [surface, artifact, version],
  );
  const mediaType = selection?.mediaType ?? 'application/json';

  // Defer all loading until the tab is first shown.
  useEffect(() => {
    if (active) setActivated(true);
  }, [active]);

  // Targets for the selected revision.
  useEffect(() => {
    if (!activated) return;
    let cancelled = false;
    setTargetsLoading(true);
    setTargetsError(null);
    (async () => {
      try {
        const res = await fetch(`/api/schemas/targets?ref=${encodeURIComponent(revisionRef)}`);
        const data = (await res.json()) as SchemaTargetsPayload & { detail?: { message?: string } };
        if (cancelled) return;
        if (!res.ok || !data.success) {
          setTargets(null);
          setTargetsError(
            data.detail?.message || data.error || 'Could not list this revision’s schemas.',
          );
        } else {
          setTargets(data);
        }
      } catch (e) {
        if (!cancelled) {
          setTargets(null);
          setTargetsError(e instanceof Error ? e.message : 'Could not list this revision’s schemas.');
        }
      } finally {
        if (!cancelled) setTargetsLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [activated, revisionRef]);

  // Registry types, once.
  useEffect(() => {
    if (!activated) return;
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch('/api/primitives');
        const data = await res.json();
        if (cancelled || !res.ok || !data?.success) return;
        const rows: PrimitiveRow[] = Array.isArray(data.primitives) ? data.primitives : [];
        const options = rows
          .map((row) => {
            const ref = row.name ? registryRefFromPrimitive({ ...row, name: row.name }) : null;
            return ref
              ? { ref, label: row.namespace ? `${row.namespace}/${row.name}` : String(row.name) }
              : null;
          })
          .filter((option): option is RegistryTargetOption => option !== null)
          .sort((a, b) => a.label.localeCompare(b.label));
        setRegistryTypes(options);
      } catch {
        // Registry types are one of three sources; the picker still works without them.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [activated]);

  // Saved payloads follow the (tenant, schema) scope.
  useEffect(() => {
    if (!tenantId || !selection) {
      setSavedPayloads([]);
      return;
    }
    setSavedPayloads(loadSavedBenchPayloads(tenantId, selection.ref));
  }, [tenantId, selection]);

  /** Clear per-schema result state (on selection/version change). */
  const resetResults = useCallback(() => {
    setValidation(null);
    setMarkers([]);
    setValidatedText(null);
    setSynthesis(null);
  }, []);

  const handleSelect = useCallback(
    (next: BenchSchemaSelection | null) => {
      setSelection(next);
      resetResults();
    },
    [resetResults],
  );

  const handleVersionChange = useCallback(
    (next: string) => {
      setVersion(next);
      setSelection(null);
      resetResults();
    },
    [resetResults],
  );

  const handleEdit = useCallback((next: string) => {
    setPayloadText(next);
    // A manual edit makes the content user-authored; the synthetic label must not overclaim.
    setSyntheticContent(false);
    // Stale markers on edited text would point at the wrong ranges.
    setMarkers([]);
  }, []);

  const handleValidate = useCallback(async () => {
    if (!selection) return;
    const budget = checkPayloadBudget(payloadText, TEST_BENCH_PAYLOAD_MAX_BYTES);
    if (!budget.withinBudget) {
      setValidation({ success: false, ok: false, error: { message: budget.message ?? undefined } });
      setMarkers([]);
      setStatus('Payload exceeds the Test Bench bound; validation refused.');
      return;
    }
    setValidating(true);
    setStatus('Validating…');
    try {
      const res = await fetch('/api/schemas/validate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          ref: selection.ref,
          instance_text: payloadText,
          media_type: mediaType,
          max_findings: TEST_BENCH_MAX_FINDINGS,
        }),
      });
      const data = (await res.json()) as BenchValidationPayload & { detail?: { message?: string } };
      if (!res.ok || !data.success) {
        const message =
          data.detail?.message ||
          (typeof data.error === 'string' ? data.error : data.error?.message) ||
          'Validation failed.';
        setValidation({ success: false, ok: false, error: { message } });
        setMarkers([]);
        setStatus('Validation failed.');
        return;
      }
      setValidation(data);
      setMarkers(findingsToMarkers(data.findings ?? [], payloadText));
      setValidatedText(data.valid === true ? payloadText : null);
      setStatus(
        data.valid === true
          ? 'Payload is valid.'
          : data.valid === false
            ? `Payload is invalid — ${data.total_findings ?? data.findings?.length ?? 0} findings.`
            : 'Validity was not checked.',
      );
    } catch (e) {
      setValidation({
        success: false,
        ok: false,
        error: { message: e instanceof Error ? e.message : 'Validation failed.' },
      });
      setMarkers([]);
      setStatus('Validation failed.');
    } finally {
      setValidating(false);
    }
  }, [selection, payloadText, mediaType]);

  const handleGenerate = useCallback(async () => {
    if (!selection) return;
    setGenerating(true);
    setStatus('Generating payloads…');
    try {
      const res = await fetch('/api/schemas/synthesize', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ref: selection.ref }),
      });
      const data = (await res.json()) as BenchSynthesisPayload & { detail?: { message?: string } };
      if (!res.ok || !data.success) {
        setSynthesis({
          success: false,
          ok: false,
          error: { message: data.detail?.message || 'Generation failed.' },
          diagnostics: data.diagnostics,
        });
        setStatus('Generation failed.');
        return;
      }
      setSynthesis(data);
      setStatus(`Generated ${data.instances?.length ?? 0} payloads (all synthetic).`);
    } catch (e) {
      setSynthesis({
        success: false,
        ok: false,
        error: { message: e instanceof Error ? e.message : 'Generation failed.' },
      });
      setStatus('Generation failed.');
    } finally {
      setGenerating(false);
    }
  }, [selection]);

  const handleLoadInstance = useCallback(
    (instance: BenchSynthesizedInstance) => {
      setPayloadText(JSON.stringify(instance.instance ?? null, null, 2));
      setSyntheticContent(true);
      setValidation(null);
      setMarkers([]);
      setValidatedText(null);
      setStatus(`Loaded generated payload "${instance.title}" (synthetic).`);
    },
    [],
  );

  const handleSelectFinding = useCallback(
    (finding: BenchFinding) => {
      const range = jsonPointerRanges(payloadText).get(finding.pointer);
      if (range) {
        editorRef.current?.reveal(range);
      } else if (typeof finding.line === 'number' && finding.line > 0) {
        const column = typeof finding.column === 'number' && finding.column > 0 ? finding.column : 1;
        editorRef.current?.reveal({
          startLine: finding.line,
          startColumn: column,
          endLine: finding.line,
          endColumn: column + 1,
        });
      }
    },
    [payloadText],
  );

  const handleSave = useCallback(
    (name: string) => {
      if (!tenantId || !selection) return;
      const next = saveBenchPayload(tenantId, selection.ref, {
        id: `sp-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
        name,
        payloadText,
        synthetic: syntheticContent,
        savedAt: Date.now(),
      });
      setSavedPayloads(next);
      setStatus(`Saved payload "${name}".`);
    },
    [tenantId, selection, payloadText, syntheticContent],
  );

  const handleLoadSaved = useCallback((payload: SavedBenchPayload) => {
    setPayloadText(payload.payloadText);
    setSyntheticContent(payload.synthetic);
    setValidation(null);
    setMarkers([]);
    setValidatedText(null);
    setStatus(`Loaded saved payload "${payload.name}".`);
  }, []);

  const handleDeleteSaved = useCallback(
    (payload: SavedBenchPayload) => {
      if (!tenantId || !selection) return;
      setSavedPayloads(deleteBenchPayload(tenantId, selection.ref, payload.id));
      setStatus(`Deleted saved payload "${payload.name}".`);
    },
    [tenantId, selection],
  );

  const copyToClipboard = useCallback(async (text: string, done: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setStatus(done);
    } catch {
      setStatus('Could not access the clipboard.');
    }
  }, []);

  const handleCopyCurl = useCallback(() => {
    if (!selection || !targets?.tenant_slug) return;
    void copyToClipboard(
      buildCurlCommand({
        restBaseUrl: REST_API_BASE_URL,
        tenantSlug: targets.tenant_slug,
        ref: selection.ref,
        payloadText,
      }),
      'curl command copied.',
    );
  }, [selection, targets, payloadText, copyToClipboard]);

  /** Fixture export is offered only for the exact text the last passing validation ran over. */
  const fixtureReady = validatedText !== null && validatedText === payloadText;

  const handleCopyFixture = useCallback(() => {
    if (!selection || !fixtureReady) return;
    const fixture = buildCorpusFixture({
      ref: selection.ref,
      payloadText,
      name: `${artifactName} ${selection.label}`,
      synthetic: syntheticContent,
    });
    void copyToClipboard(
      JSON.stringify({ manifest_entry: fixture.entry, file: { path: fixture.entry.path, content: fixture.payload } }, null, 2),
      'Corpus fixture copied (IXH-1.1 manifest entry + file content).',
    );
  }, [selection, fixtureReady, payloadText, artifactName, syntheticContent, copyToClipboard]);

  const actionButtonClass =
    'inline-flex items-center gap-2 rounded-lg border border-gray-200 bg-white px-3 py-1.5 text-sm font-medium text-gray-700 transition-colors hover:bg-gray-50 disabled:cursor-not-allowed disabled:opacity-50 dark:border-gray-700 dark:bg-gray-800 dark:text-gray-200 dark:hover:bg-gray-700';

  return (
    <section className={`${dashboardPanelClass} space-y-5 p-6`} data-testid="schema-test-bench">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 className="flex items-center gap-2 text-sm font-semibold uppercase tracking-wider text-gray-500 dark:text-gray-400">
          <FlaskConical className="h-4 w-4 text-indigo-500" aria-hidden />
          Schema Test Bench
        </h2>
        {versions.length > 1 ? (
          <div className="flex items-center gap-2">
            <label
              htmlFor={versionSelectId}
              className="text-xs font-medium uppercase tracking-wider text-gray-500 dark:text-gray-400"
            >
              Version
            </label>
            <select
              id={versionSelectId}
              data-testid="test-bench-version-select"
              className="rounded-lg border border-gray-200 bg-white px-2 py-1.5 text-sm text-gray-900 focus:outline-none focus:ring-2 focus:ring-indigo-500 dark:border-gray-700 dark:bg-gray-900 dark:text-white"
              value={version}
              onChange={(event) => handleVersionChange(event.target.value)}
            >
              {versions.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
          </div>
        ) : null}
      </div>

      {targetsError ? (
        <p data-testid="test-bench-targets-error" className="text-sm text-amber-700 dark:text-amber-300">
          {targetsError}
        </p>
      ) : null}

      <SchemaTargetPicker
        refForType={(typeKey) => buildSchemaRef(surface, artifact, version, typeKey)}
        operationBodies={targets?.operation_bodies ?? []}
        types={targets?.types ?? []}
        registryTypes={registryTypes}
        xmlDocumentRef={targets?.xml_document ? revisionRef : null}
        selectedRef={selection?.ref ?? ''}
        onSelect={handleSelect}
        disabled={targetsLoading}
      />

      {selection ? (
        <p className="font-mono text-xs text-gray-500 dark:text-gray-400" data-testid="test-bench-selected-ref">
          {selection.ref}
        </p>
      ) : null}

      <BenchPayloadEditor
        ref={editorRef}
        value={payloadText}
        onChange={handleEdit}
        markers={markers}
        synthetic={syntheticContent}
        language={mediaType === 'application/xml' ? 'xml' : 'json'}
      />

      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          data-testid="test-bench-validate"
          onClick={() => void handleValidate()}
          disabled={!selection || validating || payloadText.trim() === ''}
          className="inline-flex items-center gap-2 rounded-lg bg-indigo-600 px-3 py-1.5 text-sm font-medium text-white transition-colors hover:bg-indigo-700 disabled:cursor-not-allowed disabled:opacity-50"
        >
          <Play className="h-4 w-4" aria-hidden /> {validating ? 'Validating…' : 'Validate'}
        </button>
        <button
          type="button"
          data-testid="test-bench-copy-curl"
          onClick={handleCopyCurl}
          disabled={!selection || !targets?.tenant_slug || payloadText.trim() === ''}
          className={actionButtonClass}
          title="Copy a curl command that validates this payload against the REST endpoint (auth via $APIOME_API_KEY)."
        >
          <Terminal className="h-4 w-4 text-gray-500" aria-hidden /> Copy as curl
        </button>
        <button
          type="button"
          data-testid="test-bench-copy-fixture"
          onClick={handleCopyFixture}
          disabled={!fixtureReady}
          className={actionButtonClass}
          title={
            fixtureReady
              ? 'Copy this validated payload as an IXH-1.1 corpus manifest entry plus file content.'
              : 'Validate the payload first — only a payload that just passed can become a corpus fixture.'
          }
        >
          <PackagePlus className="h-4 w-4 text-emerald-600 dark:text-emerald-500" aria-hidden />
          Copy as fixture
        </button>
      </div>

      {/* Screen-reader-audible progress/copy feedback. */}
      <p data-testid="test-bench-status-live" aria-live="polite" className="sr-only">
        {status}
      </p>

      <BenchFindingsList result={validation} onSelectFinding={handleSelectFinding} />

      <BenchGeneratedPanel
        result={synthesis}
        generating={generating}
        enabled={Boolean(selection) && mediaType === 'application/json'}
        onGenerate={() => void handleGenerate()}
        onLoadInstance={handleLoadInstance}
      />

      <BenchSavedPayloads
        payloads={savedPayloads}
        canSave={Boolean(tenantId && selection) && payloadText.trim() !== ''}
        onSave={handleSave}
        onLoad={handleLoadSaved}
        onDelete={handleDeleteSaved}
      />

      {/* Server-persisted suites (IXH-5.7): payloads + expected verdicts, run per revision,
          with regression tracking. Additive next to the browser-local saved payloads. */}
      <BenchSuitesPanel
        surface={surface}
        artifact={artifact}
        version={version}
        payloadText={payloadText}
        syntheticContent={syntheticContent}
        active={active}
      />
    </section>
  );
}
