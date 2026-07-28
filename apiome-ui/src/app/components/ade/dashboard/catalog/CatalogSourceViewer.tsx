'use client';

/**
 * CatalogSourceViewer (MFI-25.4, #4089).
 *
 * The catalog detail's **Source & Code** tab body: the raw imported source rendered *read-only* in
 * Monaco, with a format pill / source badge / language tag toolbar, Download + Wrap actions, and an
 * offline `<pre>` fallback. It replaces the earlier download-only panel (MFI-23.9) — the download link
 * survives here so the pre-existing contract holds.
 *
 * The raw source is fetched **lazily**, the first time the Source tab is activated, from the existing
 * `GET /api/catalog/{id}/source` proxy (`sourceHref`). That proxy streams captured inline content back
 * directly, and for URL-sourced items answers with a 307 redirect that `fetch` follows to the origin —
 * so a single `fetch(sourceHref)` covers both cases (mockup `ensureMonaco`, `index.html:1517-1541`).
 *
 * Monaco is loaded through the same dynamic, SSR-disabled import the Studio code view uses
 * (`dynamic(() => import('@monaco-editor/react'), {ssr:false})`), so the server never touches it and
 * there is no SSR crash. When that import fails (offline / CDN blocked) the loader resolves to a small
 * fallback that prints the already-fetched raw source in a `<pre>` instead — the mockup's offline path.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import dynamic from 'next/dynamic';
import { Download, ExternalLink, Lock, WrapText } from 'lucide-react';
import { FormatPill } from '@/app/components/ui/catalog/FormatPill';
import { SourceBadge } from '@/app/components/ui/catalog/SourceBadge';
import { monacoLanguageForCatalogFormat } from '@/app/utils/catalog-source-language';
import type { CatalogSource } from '@/app/utils/catalog-format-registry';
import { dashboardPanelClass } from '@/app/components/ade/dashboard/dashboardScreenClasses';
import { cn } from '@lib/utils';

/**
 * The offline fallback the Monaco dynamic import resolves to when the editor library can't load. It
 * consumes the same `value` prop Monaco does, so the already-fetched raw source still renders — just
 * in a plain, wrappable `<pre>` instead of the syntax-highlighted editor.
 */
function OfflineSourceFallback({ value }: { value?: string }) {
  return (
    <div
      data-testid="catalog-detail-source-fallback"
      className="h-full overflow-auto p-4 text-xs text-gray-700 dark:text-gray-300"
    >
      <p className="mb-2 font-medium text-rose-600 dark:text-rose-400">
        The code editor could not be loaded (offline?). Raw source:
      </p>
      <pre className="whitespace-pre-wrap break-words font-mono">{value ?? ''}</pre>
    </div>
  );
}

/**
 * Monaco, loaded once at module scope exactly like `studio/code/page.tsx`: dynamically imported with
 * SSR disabled. If the import rejects, the loader resolves to {@link OfflineSourceFallback} so the tab
 * degrades to a `<pre>` rather than crashing.
 */
const MonacoEditor = dynamic(
  () =>
    import('@monaco-editor/react')
      .then((mod) => mod.default)
      .catch(() => OfflineSourceFallback),
  {
    ssr: false,
    loading: () => (
      <div className="flex h-full items-center justify-center text-sm text-gray-500 dark:text-gray-400">
        Loading source…
      </div>
    ),
  },
);

/** The fetch lifecycle of the raw source (`idle`/`loading` render the spinner until the fetch lands). */
type SourceStatus = 'idle' | 'loading' | 'loaded' | 'error';

export interface CatalogSourceViewerProps {
  /** The `/api/catalog/{id}/source` proxy URL the raw source is fetched from and downloaded via. */
  sourceHref: string;
  /** The item's raw `sourceFormat`, used both for the format pill and the Monaco language mapping. */
  sourceFormat: string | null | undefined;
  /** The resolved source-material descriptor for the {@link SourceBadge} (absent → no badge). */
  resolvedSource: CatalogSource | undefined;
  /** Whether the raw source can be retrieved (false → nothing was captured at import). */
  downloadable: boolean;
  /** Whether captured inline content exists (drives the download-vs-view affordance). */
  hasContent: boolean;
  /** The original source URL, if any — surfaced as an "Open source URL" link. */
  sourceUri: string | null | undefined;
  /** Whether the Source tab is active; the raw source is fetched the first time this is true. */
  active: boolean;
  /**
   * Optional 1-based line to reveal when the editor loads (from ``?line=`` / compatibility evidence
   * deep links, CLX-2.3) — and re-revealed whenever it *changes*, which is what lets the Format
   * details tab (CPDO-2.1) send the reader to a second construct without remounting the editor.
   */
  highlightLine?: number | null;
  /** Optional path label shown when a deep link targeted a specific source file. */
  focusSourcePath?: string | null;
  /**
   * Who asked for {@link highlightLine}, so the note names the real reason rather than always
   * claiming a compatibility deep link.
   */
  highlightOrigin?: 'compatibility' | 'format-analysis';
}

/** The slice of the Monaco editor API this viewer drives, so the ref needs no editor types. */
interface RevealableEditor {
  revealLineInCenter: (line: number) => void;
  setPosition: (position: { lineNumber: number; column: number }) => void;
}

/**
 * Render a catalog item's raw source read-only in Monaco, fetching it lazily on first activation.
 *
 * @param props See {@link CatalogSourceViewerProps}.
 * @returns The Source & Code panel body.
 */
export function CatalogSourceViewer({
  sourceHref,
  sourceFormat,
  resolvedSource,
  downloadable,
  hasContent,
  sourceUri,
  active,
  highlightLine = null,
  focusSourcePath = null,
  highlightOrigin = 'compatibility',
}: CatalogSourceViewerProps) {
  const [status, setStatus] = useState<SourceStatus>('idle');
  const [raw, setRaw] = useState<string>('');
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  // Wrap is on by default (mockup `wordWrap: 'on'`); the toolbar toggle flips it.
  const [wrap, setWrap] = useState(true);
  // Guards the one-shot lazy fetch so re-activating the tab never re-fetches.
  const fetchStartedRef = useRef(false);
  // The mounted editor, so a *later* highlight request can be revealed without remounting (and
  // therefore re-fetching) the source. Null until Monaco mounts, and for the offline fallback.
  const editorRef = useRef<RevealableEditor | null>(null);

  const loadSource = useCallback(async () => {
    // Lazy + one-shot: only fetch once the tab is active, only when there is a source to fetch, and
    // never twice. Guarding here (not in the effect) keeps the effect a single `void` call.
    if (!active || !downloadable || fetchStartedRef.current) return;
    fetchStartedRef.current = true;
    setStatus('loading');
    setErrorMessage(null);
    // Resolve into locals and commit the outcome once in `finally`, so the fetch drives a single
    // terminal state transition (loaded/error) rather than several branch-by-branch setState calls.
    let loadedText: string | null = null;
    let failureMessage: string | null = null;
    try {
      // `fetch` follows the proxy's 307 redirect for URL-sourced items to the origin automatically.
      const res = await fetch(sourceHref);
      if (res.ok) {
        loadedText = await res.text();
      } else {
        // Errors (e.g. 404 "no source captured") come back as JSON from the proxy.
        failureMessage = 'The raw source could not be loaded.';
        try {
          const data = await res.json();
          if (data && typeof data.error === 'string' && data.error.trim()) failureMessage = data.error;
        } catch {
          /* non-JSON error body — keep the generic message. */
        }
      }
    } catch (e) {
      // Network failure (offline) — surface a note (there is nothing to put in `<pre>`).
      failureMessage = e instanceof Error ? e.message : 'The raw source could not be loaded.';
    } finally {
      if (failureMessage != null) {
        setErrorMessage(failureMessage);
        setStatus('error');
      } else {
        setRaw(loadedText ?? '');
        setStatus('loaded');
      }
    }
  }, [active, downloadable, sourceHref]);

  useEffect(() => {
    void loadSource();
  }, [loadSource]);

  /** Centre `line` in the mounted editor, ignoring a non-line or an editor that is not up yet. */
  const revealLine = useCallback((line: number | null | undefined) => {
    if (!editorRef.current || typeof line !== 'number' || line <= 0) return;
    editorRef.current.revealLineInCenter(line);
    editorRef.current.setPosition({ lineNumber: line, column: 1 });
  }, []);

  // Re-reveal whenever the requested line changes. The first reveal happens in `onMount` (the editor
  // does not exist before then); this covers every later request — a second construct followed from
  // the Format details tab, or a second compatibility deep link on the same mounted editor.
  useEffect(() => {
    revealLine(highlightLine);
  }, [highlightLine, revealLine]);

  // The language tag: format-derived, then refined by the loaded bytes for JSON-or-YAML formats.
  const language = monacoLanguageForCatalogFormat(sourceFormat, status === 'loaded' ? raw : null);

  return (
    <section className={`${dashboardPanelClass} p-6`} data-testid="catalog-detail-source">
      <h2 className="text-sm font-semibold uppercase tracking-wider text-gray-500 dark:text-gray-400">
        Source &amp; code
      </h2>

      {!downloadable ? (
        <>
          <div className="mt-3 flex flex-wrap items-center gap-3">
            {resolvedSource ? (
              <SourceBadge source={resolvedSource} />
            ) : (
              <span className="text-sm text-gray-500 dark:text-gray-400">
                Original source provenance was not recorded for this item.
              </span>
            )}
          </div>
          <p
            data-testid="catalog-detail-no-source"
            className="mt-4 text-sm text-gray-500 dark:text-gray-400"
          >
            The raw source was not captured at import, so it cannot be viewed or downloaded here.
          </p>
        </>
      ) : (
        <>
          {/* Toolbar: format pill · source badge · language tag · Download · Wrap. */}
          <div className="mt-3 flex flex-wrap items-center gap-2">
            <FormatPill format={sourceFormat} />
            {resolvedSource ? <SourceBadge source={resolvedSource} /> : null}
            <span
              data-testid="catalog-detail-source-lang"
              className="inline-flex items-center rounded-md bg-gray-100 px-2 py-0.5 font-mono text-xs text-gray-600 dark:bg-gray-700/60 dark:text-gray-300"
            >
              language: {language}
            </span>
            <div className="ml-auto flex flex-wrap items-center gap-2">
              <a
                href={sourceHref}
                data-testid="catalog-detail-download"
                className="inline-flex items-center gap-2 rounded-lg border border-gray-200 bg-white px-3 py-1.5 text-sm font-medium text-gray-700 transition-colors hover:bg-gray-50 dark:border-gray-700 dark:bg-gray-800 dark:text-gray-200 dark:hover:bg-gray-700"
                {...(hasContent
                  ? { download: '' }
                  : { target: '_blank', rel: 'noopener noreferrer' })}
              >
                <Download className="h-4 w-4 text-indigo-500" />{' '}
                {hasContent ? 'Download raw source' : 'View source'}
              </a>
              <button
                type="button"
                data-testid="catalog-detail-source-wrap"
                aria-pressed={wrap}
                onClick={() => setWrap((w) => !w)}
                className={cn(
                  'inline-flex items-center gap-2 rounded-lg border px-3 py-1.5 text-sm font-medium transition-colors',
                  wrap
                    ? 'border-indigo-200 bg-indigo-50 text-indigo-700 hover:bg-indigo-100 dark:border-indigo-800 dark:bg-indigo-950/40 dark:text-indigo-300'
                    : 'border-gray-200 bg-white text-gray-700 hover:bg-gray-50 dark:border-gray-700 dark:bg-gray-800 dark:text-gray-200 dark:hover:bg-gray-700',
                )}
              >
                <WrapText className="h-4 w-4" /> Wrap
              </button>
              {sourceUri ? (
                <a
                  href={sourceUri}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex items-center gap-2 rounded-lg border border-gray-200 bg-white px-3 py-1.5 text-sm font-medium text-gray-700 transition-colors hover:bg-gray-50 dark:border-gray-700 dark:bg-gray-800 dark:text-gray-200 dark:hover:bg-gray-700"
                >
                  <ExternalLink className="h-4 w-4 text-indigo-500" /> Open source URL
                </a>
              ) : null}
            </div>
          </div>

          {/* Read-only notice (mockup) — catalog items are never editable here. */}
          <p className="mt-3 flex items-start gap-1.5 rounded-lg border border-indigo-100 bg-indigo-50/60 px-3 py-2 text-xs text-indigo-700 dark:border-indigo-900/50 dark:bg-indigo-950/30 dark:text-indigo-300">
            <Lock className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden /> Read-only view of the raw
            imported source.
          </p>

          {typeof highlightLine === 'number' && highlightLine > 0 ? (
            <p
              data-testid="catalog-detail-source-highlight"
              className="catalog-source-highlight-note mt-2 text-xs text-gray-600 dark:text-gray-400"
            >
              {highlightOrigin === 'format-analysis'
                ? 'Format details construct'
                : 'Compatibility deep link'}
              {focusSourcePath ? (
                <>
                  {' '}
                  for <span className="font-mono">{focusSourcePath}</span>
                </>
              ) : null}
              : highlighting line {highlightLine}.
            </p>
          ) : null}

          {/* Editor host: Monaco (or the offline `<pre>` fallback), an error note, or a spinner. */}
          <div
            data-testid="catalog-detail-source-editor"
            className="mt-3 h-[520px] overflow-hidden rounded-xl border border-gray-200 dark:border-gray-700"
          >
            {status === 'loaded' ? (
              <MonacoEditor
                height="100%"
                language={language}
                value={raw}
                theme="vs-dark"
                options={{
                  readOnly: true,
                  domReadOnly: true,
                  minimap: { enabled: true },
                  fontSize: 13,
                  fontFamily: "'JetBrains Mono', 'Fira Code', Consolas, monospace",
                  lineNumbers: 'on',
                  scrollBeyondLastLine: false,
                  wordWrap: wrap ? 'on' : 'off',
                  padding: { top: 14, bottom: 14 },
                  automaticLayout: true,
                }}
                onMount={(editor: RevealableEditor) => {
                  editorRef.current = editor;
                  revealLine(highlightLine);
                }}
              />
            ) : status === 'error' ? (
              <div
                data-testid="catalog-detail-source-error"
                className="flex h-full items-center justify-center p-6 text-center text-sm text-gray-500 dark:text-gray-400"
              >
                {errorMessage || 'The raw source could not be loaded.'}
              </div>
            ) : (
              <div className="flex h-full items-center justify-center text-sm text-gray-500 dark:text-gray-400">
                Loading source…
              </div>
            )}
          </div>
        </>
      )}
    </section>
  );
}
