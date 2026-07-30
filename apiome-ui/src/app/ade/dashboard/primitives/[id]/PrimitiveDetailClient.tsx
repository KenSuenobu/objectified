'use client';

import { useCallback, useEffect, useMemo, useState, type ComponentType } from 'react';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import {
  ArrowLeft,
  Library,
  AlertCircle,
  Shield,
  Lock,
  Pencil,
  Upload,
  Archive,
  Braces,
  Waypoints,
  FileJson,
  GitFork,
  Info,
  BarChart3,
  GitCommitVertical,
  Copy,
  Check,
  Download,
} from 'lucide-react';
import { Alert } from '@/app/components/ui/Alert';
import { LoadingState } from '@/app/components/ui/LoadingState';
import { Button } from '@/app/components/ui/Button';
import { ReadOnlyCodeViewer } from '@/app/components/ade/dashboard/export/ReadOnlyCodeViewer';
import { downloadBlob } from '@/app/components/ade/dashboard/export/exportDownload';
import { PrimitiveTestForm } from '../PrimitiveTestForm';
import {
  dashboardMainClass,
  dashboardPanelClass,
  dashboardPanelPaddedClass,
} from '@/app/components/ade/dashboard/dashboardScreenClasses';
import {
  baseChainNodeHref,
  baseChainNodeLabel,
  buildBaseChain,
  buildExampleInstance,
  deriveOwner,
  deriveVersionRoot,
  effectiveNamespace,
  exportFileName,
  refEdgeTargetHref,
  refEdgeTargetLabel,
  scopeLabel,
  serializeSchemaExport,
  summarizeUsage,
  type DependentRef,
  type RefEdge,
} from '../primitiveDetailModel';

interface PrimitiveDetail {
  id: string;
  name: string;
  description: string | null;
  category: string;
  schema: Record<string, unknown>;
  is_system: boolean;
  is_public?: boolean;
  namespace?: string | null;
  schema_id?: string | null;
  base_uri?: string | null;
  draft?: string;
  source?: string;
  refs?: RefEdge[];
  dependents?: DependentRef[];
  usage_count: number;
  tags?: string[];
  created_at?: string | null;
}

const badgeBase = 'text-[10px] uppercase tracking-wider px-1.5 py-0.5 rounded inline-flex items-center gap-1';
const codeBlockClass =
  'rounded-lg bg-gray-900 dark:bg-black/40 p-4 font-mono text-[11px] leading-relaxed text-gray-200 overflow-x-auto whitespace-pre';
const sectionHeadClass = 'px-5 py-4 border-b border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-900 flex items-center gap-3';

/**
 * Height bounds for the JSON Schema editor. Monaco needs a definite pixel viewport (see
 * `ReadOnlyCodeViewer`), so the box is sized from the document itself: a two-line primitive gets a
 * short editor instead of a mostly-empty one, and a sprawling object schema stops growing at
 * {@link SCHEMA_VIEWER_MAX_HEIGHT} and scrolls internally rather than pushing the rest of the page down.
 */
const SCHEMA_VIEWER_MIN_HEIGHT = 200;
const SCHEMA_VIEWER_MAX_HEIGHT = 560;
/** Monaco's line box at the viewer's 13px font, plus its 14px top/bottom padding. */
const SCHEMA_VIEWER_LINE_HEIGHT = 19;
const SCHEMA_VIEWER_PADDING = 28;

/** Size the schema editor to its content, clamped to the bounds above. */
function schemaViewerHeight(json: string): number {
  const lines = json.split('\n').length;
  const natural = lines * SCHEMA_VIEWER_LINE_HEIGHT + SCHEMA_VIEWER_PADDING;
  return Math.min(SCHEMA_VIEWER_MAX_HEIGHT, Math.max(SCHEMA_VIEWER_MIN_HEIGHT, natural));
}

/** How long the Copy button holds its "Copied" / "Copy failed" acknowledgement. */
const COPY_ACK_MS = 1500;

interface SchemaActionButtonProps {
  testId: string;
  label: string;
  title: string;
  icon: ComponentType<{ className?: string; 'aria-hidden'?: boolean }>;
  onClick: () => void;
  tone?: 'default' | 'success' | 'danger';
}

/**
 * One action in the JSON Schema card header, styled to match the export viewer's toolbar buttons
 * ({@link ViewerActionsBar}) so the two read as the same control. The visible text is the
 * accessible name — no `aria-label` — leaving the tooltip free for the longer explanation.
 */
function SchemaActionButton({ testId, label, title, icon: Icon, onClick, tone = 'default' }: SchemaActionButtonProps) {
  const toneClass =
    tone === 'success'
      ? 'border-emerald-200 bg-emerald-50 text-emerald-700 dark:border-emerald-800 dark:bg-emerald-950/40 dark:text-emerald-300'
      : tone === 'danger'
        ? 'border-red-200 bg-red-50 text-red-700 dark:border-red-800 dark:bg-red-950/40 dark:text-red-300'
        : 'border-gray-200 bg-white/95 text-gray-700 hover:bg-gray-50 dark:border-gray-600 dark:bg-gray-900/95 dark:text-gray-200 dark:hover:bg-gray-800';

  return (
    <button
      type="button"
      data-testid={testId}
      onClick={onClick}
      title={title}
      className={`inline-flex items-center gap-1 rounded-md border px-2 py-1 text-xs font-medium shadow-sm transition-colors ${toneClass}`}
    >
      <Icon className="h-3.5 w-3.5" aria-hidden />
      {label}
    </button>
  );
}

function formatDate(iso: string | null | undefined): string {
  if (!iso) return '—';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '—';
  return date.toISOString().slice(0, 10);
}

export default function PrimitiveDetailClient() {
  const params = useParams<{ id: string }>();
  const [primitive, setPrimitive] = useState<PrimitiveDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  /** Transient "Copied" / "Copy failed" acknowledgement on the schema card's Copy button. */
  const [schemaCopied, setSchemaCopied] = useState(false);
  const [copyFailed, setCopyFailed] = useState(false);

  const loadPrimitive = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const response = await fetch(`/api/primitives/${params.id}`);
      const data = await response.json();
      if (!response.ok || !data.success) {
        setError(data.error || 'Failed to load primitive');
        setPrimitive(null);
        return;
      }
      setPrimitive(data.primitive as PrimitiveDetail);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load primitive');
      setPrimitive(null);
    } finally {
      setLoading(false);
    }
  }, [params.id]);

  useEffect(() => {
    if (params.id) {
      void loadPrimitive();
    }
  }, [params.id, loadPrimitive]);

  // Let the copy acknowledgement fall back to the idle label after a beat.
  useEffect(() => {
    if (!schemaCopied && !copyFailed) return undefined;
    const timer = setTimeout(() => {
      setSchemaCopied(false);
      setCopyFailed(false);
    }, COPY_ACK_MS);
    return () => clearTimeout(timer);
  }, [schemaCopied, copyFailed]);

  // The header's Export action and the schema card's Download button are the same operation, so
  // both go through here — one filename and one serialization for the file the user ends up with.
  const handleExport = useCallback(() => {
    if (!primitive) return;
    const blob = new Blob([serializeSchemaExport(primitive.schema)], { type: 'application/json' });
    downloadBlob(blob, exportFileName(primitive.name));
  }, [primitive]);

  const handleCopySchema = useCallback(async () => {
    if (!primitive) return;
    try {
      await navigator.clipboard.writeText(serializeSchemaExport(primitive.schema));
      setSchemaCopied(true);
    } catch {
      // Clipboard unavailable (insecure context / denied permission) — say so rather than
      // flashing "Copied" for a write that never landed.
      setCopyFailed(true);
    }
  }, [primitive]);

  const baseChain = useMemo(
    () => (primitive ? buildBaseChain(primitive.name, primitive.refs) : []),
    [primitive]
  );
  const usage = useMemo(
    () => (primitive ? summarizeUsage(primitive.dependents, primitive.usage_count) : null),
    [primitive]
  );
  const exampleInstance = useMemo(
    () => (primitive ? buildExampleInstance(primitive.schema) : null),
    [primitive]
  );
  const schemaJson = useMemo(
    () => (primitive ? JSON.stringify(primitive.schema, null, 2) : ''),
    [primitive]
  );

  // The schema's own `$id` is the authority for where the type lives, so the namespace is read back
  // out of it; the stored column only stands in when the id carries no recoverable namespace (an
  // explicit `base_uri`, or an author-declared `$id` outside the registry mount). Preferring the
  // document's `$id` over the `schema_id` column keeps the display tied to the schema on screen.
  const schemaIdentity =
    (typeof primitive?.schema?.$id === 'string' ? primitive.schema.$id : null) ?? primitive?.schema_id ?? null;
  const namespacePath = primitive ? effectiveNamespace(schemaIdentity, primitive.namespace) : null;
  const versionRoot = primitive ? deriveVersionRoot(namespacePath, primitive.base_uri) : null;
  const dependents = primitive?.dependents ?? [];

  return (
    <>
      <header className="border-b border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800">
        <div className="px-6 py-4 flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
          <div className="min-w-0">
            <Link
              href="/ade/dashboard/primitives"
              className="text-xs text-indigo-600 dark:text-indigo-400 hover:underline inline-flex items-center gap-1 mb-2"
            >
              <ArrowLeft className="w-3.5 h-3.5" /> Primitives
            </Link>
            {namespacePath ? (
              <p className="text-xs text-gray-500 dark:text-gray-400 font-mono mb-1">{namespacePath}</p>
            ) : null}
            <h2 className="text-2xl font-bold text-gray-900 dark:text-white flex items-center gap-2">
              <Library className="w-6 h-6 text-indigo-600 dark:text-indigo-400" />
              {loading ? 'Loading type…' : primitive?.name ?? 'Type detail'}
            </h2>
            {primitive ? (
              <div className="flex flex-wrap items-center gap-2 mt-2">
                {primitive.is_system ? (
                  <span className={`${badgeBase} bg-teal-100 text-teal-700 dark:bg-teal-900/40 dark:text-teal-300`}>
                    <Shield className="w-3 h-3" /> {scopeLabel(true)}
                  </span>
                ) : (
                  <span className={`${badgeBase} bg-green-100 text-green-800 dark:bg-green-900/30 dark:text-green-300`}>
                    {scopeLabel(false)}
                  </span>
                )}
                <span className={`${badgeBase} bg-gray-100 text-gray-600 dark:bg-gray-700 dark:text-gray-300`}>
                  {primitive.category}
                </span>
                <span className={`${badgeBase} bg-indigo-100 text-indigo-700 dark:bg-indigo-900/40 dark:text-indigo-300 font-mono`}>
                  draft {primitive.draft ?? '2020-12'}
                </span>
                {primitive.is_system ? (
                  <span className={`${badgeBase} bg-amber-100 text-amber-700 dark:bg-amber-900/40 dark:text-amber-300`}>
                    <Lock className="w-3 h-3" /> immutable (core)
                  </span>
                ) : null}
              </div>
            ) : null}
          </div>

          {primitive ? (
            <div className="flex items-center gap-2 flex-shrink-0 flex-wrap">
              {primitive.is_system ? (
                <Button
                  variant="outline"
                  size="sm"
                  disabled
                  title="System primitives are immutable and cannot be edited"
                >
                  <Pencil className="w-4 h-4" /> Edit
                </Button>
              ) : (
                <Link href={`/ade/dashboard/primitives?edit=${primitive.id}`}>
                  <Button variant="outline" size="sm">
                    <Pencil className="w-4 h-4" /> Edit
                  </Button>
                </Link>
              )}
              <Button variant="outline" size="sm" onClick={handleExport}>
                <Upload className="w-4 h-4" /> Export
              </Button>
              <Button
                variant="outline"
                size="sm"
                disabled
                title="Deprecation lifecycle (sunset dates) arrives with version roots — see #3482"
                className="border-rose-200 text-rose-600 hover:bg-rose-50 dark:border-rose-800/60 dark:text-rose-400 dark:hover:bg-rose-900/20"
              >
                <Archive className="w-4 h-4" /> Deprecate
              </Button>
            </div>
          ) : null}
        </div>
      </header>

      <main className={dashboardMainClass}>
        {loading ? (
          <LoadingState minHeightClassName="min-h-[240px]" message="Loading type detail…" />
        ) : error ? (
          <Alert variant="error">
            <AlertCircle className="h-4 w-4" />
            <span>{error}</span>
          </Alert>
        ) : primitive ? (
          <div className="grid grid-cols-1 xl:grid-cols-3 gap-6">
            {/* Main column */}
            <div className="xl:col-span-2 space-y-6">
              {primitive.description ? (
                <section className={dashboardPanelPaddedClass}>
                  <p className="text-sm text-gray-700 dark:text-gray-300">{primitive.description}</p>
                </section>
              ) : null}

              <section className={`${dashboardPanelClass} p-5`}>
                <div className="mb-3 flex items-start justify-between gap-3">
                  <h3 className="text-sm font-semibold flex items-center gap-2 text-gray-900 dark:text-white">
                    <Braces className="w-4 h-4 text-indigo-500" /> JSON Schema{' '}
                    <span className="font-mono text-gray-400 font-normal">({primitive.draft ?? '2020-12'})</span>
                  </h3>
                  {/* Card actions, pinned top-right: take the schema away as a file, or as text. */}
                  <div className="flex shrink-0 items-center gap-1.5" role="group" aria-label="JSON Schema actions">
                    <SchemaActionButton
                      testId="primitive-detail-schema-copy"
                      label={schemaCopied ? 'Copied' : copyFailed ? 'Copy failed' : 'Copy'}
                      title={copyFailed ? 'Could not write to the clipboard' : 'Copy the JSON Schema to the clipboard'}
                      icon={schemaCopied ? Check : Copy}
                      tone={schemaCopied ? 'success' : copyFailed ? 'danger' : 'default'}
                      onClick={() => void handleCopySchema()}
                    />
                    <SchemaActionButton
                      testId="primitive-detail-schema-download"
                      label="Download"
                      title={`Download ${exportFileName(primitive.name)}`}
                      icon={Download}
                      onClick={handleExport}
                    />
                  </div>
                </div>
                {/* The schema renders in the shared read-only Monaco viewer (MFX-43.1) rather than a
                    plain `<pre>`, so it arrives syntax-highlighted, foldable, and theme-matched —
                    the same viewer the catalog import dialog and export surfaces use. */}
                <ReadOnlyCodeViewer
                  value={schemaJson}
                  language="json"
                  height={schemaViewerHeight(schemaJson)}
                  documentLabel={`${primitive.name} JSON Schema`}
                  className="rounded-lg border border-gray-200 dark:border-gray-700"
                  editorTestId="primitive-detail-schema-editor"
                  fallbackTestId="primitive-detail-schema-fallback"
                />
              </section>

              <PrimitiveTestForm schema={primitive.schema} name={primitive.name} />

              <section className={`${dashboardPanelClass} overflow-hidden`}>
                <div className={sectionHeadClass}>
                  <Waypoints className="w-5 h-5 text-indigo-500" />
                  <div>
                    <h3 className="text-base font-semibold text-gray-900 dark:text-white">Reference resolution</h3>
                    <p className="text-xs text-gray-500 dark:text-gray-400">
                      Relative <span className="font-mono">$ref</span> values resolved against the type&apos;s base URL
                      · click a resolved <span className="font-mono">$ref</span> to open the type it points at
                    </p>
                  </div>
                </div>
                {(primitive.refs?.length ?? 0) > 0 ? (
                  <table className="w-full text-sm">
                    <thead className="text-[10px] uppercase tracking-wider text-gray-500 dark:text-gray-400 bg-gray-50/60 dark:bg-gray-900/40">
                      <tr>
                        <th className="text-left px-5 py-2 font-semibold">Relative $ref</th>
                        <th className="text-left px-3 py-2 font-semibold">Resolved target</th>
                        <th className="text-right px-5 py-2 font-semibold">Status</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-gray-100 dark:divide-gray-700/60">
                      {primitive.refs?.map((edge, index) => {
                        // A resolved edge knows which type it points at, so the $ref opens it.
                        // An unresolved one has no target and stays plain text.
                        const targetHref = refEdgeTargetHref(edge);
                        return (
                        <tr key={`${edge.relative_ref}-${index}`} className="hover:bg-gray-50/60 dark:hover:bg-gray-900/30">
                          <td className="px-5 py-3 font-mono text-xs text-emerald-600 dark:text-emerald-400">
                            {edge.relative_ref ? (
                              targetHref ? (
                                <Link
                                  href={targetHref}
                                  data-testid={`ref-edge-link-${index}`}
                                  title={refEdgeTargetLabel(edge)}
                                  aria-label={refEdgeTargetLabel(edge)}
                                  className="underline decoration-dotted underline-offset-2 hover:decoration-solid focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500 rounded"
                                >
                                  {edge.relative_ref}
                                </Link>
                              ) : (
                                edge.relative_ref
                              )
                            ) : (
                              '—'
                            )}
                          </td>
                          <td className="px-3 py-3 font-mono text-xs text-gray-600 dark:text-gray-300">
                            {edge.resolved_target ?? '—'}
                          </td>
                          <td className="px-5 py-3 text-right">
                            <span
                              className={`${badgeBase} ${
                                edge.status === 'unresolved'
                                  ? 'bg-amber-100 text-amber-700 dark:bg-amber-900/40 dark:text-amber-300'
                                  : 'bg-emerald-100 text-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-300'
                              }`}
                            >
                              {edge.status ?? 'unknown'}
                            </span>
                          </td>
                        </tr>
                        );
                      })}
                    </tbody>
                  </table>
                ) : (
                  <p className="px-5 py-4 text-sm text-gray-500 dark:text-gray-400">
                    This type has no relative <span className="font-mono">$ref</span> values — it resolves to a flat schema.
                  </p>
                )}
                {primitive.base_uri ? (
                  <div className="px-5 py-3 border-t border-gray-100 dark:border-gray-700/60 text-[11px] text-gray-500 font-mono">
                    Base: {primitive.base_uri}
                  </div>
                ) : null}
              </section>

              {exampleInstance !== null ? (
                <section className={`${dashboardPanelClass} p-5`}>
                  <h3 className="text-sm font-semibold mb-3 flex items-center gap-2 text-gray-900 dark:text-white">
                    <FileJson className="w-4 h-4 text-indigo-500" /> Example instance
                  </h3>
                  <pre className={codeBlockClass}>{JSON.stringify(exampleInstance, null, 2)}</pre>
                </section>
              ) : null}

              <section className={`${dashboardPanelClass} overflow-hidden`}>
                <div className={sectionHeadClass}>
                  <GitFork className="w-5 h-5 text-indigo-500" />
                  <div>
                    <h3 className="text-base font-semibold text-gray-900 dark:text-white">Dependents</h3>
                    <p className="text-xs text-gray-500 dark:text-gray-400">
                      Types referencing <span className="font-mono">{primitive.schema_id ?? primitive.name}</span>
                    </p>
                  </div>
                </div>
                {dependents.length > 0 ? (
                  <table className="w-full text-sm">
                    <thead className="text-[10px] uppercase tracking-wider text-gray-500 dark:text-gray-400 bg-gray-50/60 dark:bg-gray-900/40">
                      <tr>
                        <th className="text-left px-5 py-2 font-semibold">Type</th>
                        <th className="text-left px-3 py-2 font-semibold">Property</th>
                        <th className="text-right px-5 py-2 font-semibold">Scope</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-gray-100 dark:divide-gray-700/60">
                      {dependents.map((dep, index) => (
                        <tr key={`${dep.schema_id ?? dep.name}-${index}`} className="hover:bg-gray-50/60 dark:hover:bg-gray-900/30">
                          <td className="px-5 py-3 font-mono text-xs text-gray-600 dark:text-gray-300">
                            {dep.namespace ? `${dep.namespace}/${dep.name ?? ''}` : dep.name ?? dep.schema_id ?? '—'}
                          </td>
                          <td className="px-3 py-3 font-mono text-xs text-gray-500">{dep.property ?? '—'}</td>
                          <td className="px-5 py-3 text-right">
                            <span
                              className={`${badgeBase} ${
                                dep.scope === 'system'
                                  ? 'bg-teal-100 text-teal-700 dark:bg-teal-900/40 dark:text-teal-300'
                                  : 'bg-indigo-100 text-indigo-700 dark:bg-indigo-900/40 dark:text-indigo-300'
                              }`}
                            >
                              {dep.scope === 'system' ? 'System · core' : `Tenant${dep.tenant_label ? ` · ${dep.tenant_label}` : ''}`}
                            </span>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                ) : (
                  <p className="px-5 py-4 text-sm text-gray-500 dark:text-gray-400">
                    No types reference this primitive yet. The reverse index (used-by properties) populates this list
                    as bindings are added.
                  </p>
                )}
              </section>
            </div>

            {/* Right rail */}
            <div className="space-y-6">
              <section className={`${dashboardPanelClass} p-5`}>
                <h3 className="text-sm font-semibold mb-3 flex items-center gap-2 text-gray-900 dark:text-white">
                  <Info className="w-4 h-4 text-indigo-500" /> Metadata
                </h3>
                <dl className="space-y-3 text-xs">
                  <div>
                    <dt className="text-gray-500 dark:text-gray-400 mb-0.5">$id</dt>
                    <dd className="font-mono text-[10px] break-all text-gray-700 dark:text-gray-300">
                      {primitive.schema_id ?? '—'}
                    </dd>
                  </div>
                  <div className="flex items-center justify-between">
                    <dt className="text-gray-500 dark:text-gray-400">Scope</dt>
                    <dd>
                      <span
                        className={`${badgeBase} ${
                          primitive.is_system
                            ? 'bg-teal-100 text-teal-700 dark:bg-teal-900/40 dark:text-teal-300'
                            : 'bg-green-100 text-green-800 dark:bg-green-900/30 dark:text-green-300'
                        }`}
                      >
                        {scopeLabel(primitive.is_system)}
                      </span>
                    </dd>
                  </div>
                  <div className="flex items-center justify-between">
                    <dt className="text-gray-500 dark:text-gray-400">Namespace</dt>
                    <dd className="font-mono text-gray-700 dark:text-gray-300">{namespacePath ?? '—'}</dd>
                  </div>
                  <div className="flex items-center justify-between">
                    <dt className="text-gray-500 dark:text-gray-400">Version root</dt>
                    <dd className="font-mono text-gray-700 dark:text-gray-300">{versionRoot ?? '—'}</dd>
                  </div>
                  <div className="flex items-center justify-between">
                    <dt className="text-gray-500 dark:text-gray-400">Owner</dt>
                    <dd className="font-mono text-gray-700 dark:text-gray-300">
                      {deriveOwner(primitive.is_system, namespacePath)}
                    </dd>
                  </div>
                  <div className="flex items-center justify-between">
                    <dt className="text-gray-500 dark:text-gray-400">Source</dt>
                    <dd className="font-mono text-gray-700 dark:text-gray-300">{primitive.source ?? 'human'}</dd>
                  </div>
                  <div className="flex items-center justify-between">
                    <dt className="text-gray-500 dark:text-gray-400">Created</dt>
                    <dd className="font-mono text-gray-700 dark:text-gray-300">{formatDate(primitive.created_at)}</dd>
                  </div>
                  <div className="flex items-center justify-between">
                    <dt className="text-gray-500 dark:text-gray-400">Mutability</dt>
                    <dd
                      className={`inline-flex items-center gap-1 font-mono ${
                        primitive.is_system ? 'text-amber-600 dark:text-amber-400' : 'text-gray-700 dark:text-gray-300'
                      }`}
                    >
                      {primitive.is_system ? (
                        <>
                          <Lock className="w-3 h-3" /> immutable · core
                        </>
                      ) : (
                        'editable · tenant'
                      )}
                    </dd>
                  </div>
                </dl>
              </section>

              {usage ? (
                <section className={`${dashboardPanelClass} p-5`}>
                  <h3 className="text-sm font-semibold mb-3 flex items-center gap-2 text-gray-900 dark:text-white">
                    <BarChart3 className="w-4 h-4 text-indigo-500" /> Used in
                  </h3>
                  <div className="grid grid-cols-3 gap-2 text-center">
                    <div className="rounded-lg bg-gray-50 dark:bg-gray-900/40 p-3">
                      <p className="text-2xl font-bold font-mono text-indigo-600 dark:text-indigo-400">{usage.dependentTypes}</p>
                      <p className="text-[10px] text-gray-500 mt-1">dependent types</p>
                    </div>
                    <div className="rounded-lg bg-gray-50 dark:bg-gray-900/40 p-3">
                      <p className="text-2xl font-bold font-mono text-gray-900 dark:text-white">{usage.properties}</p>
                      <p className="text-[10px] text-gray-500 mt-1">properties</p>
                    </div>
                    <div className="rounded-lg bg-gray-50 dark:bg-gray-900/40 p-3">
                      <p className="text-2xl font-bold font-mono text-gray-900 dark:text-white">{usage.tenants}</p>
                      <p className="text-[10px] text-gray-500 mt-1">tenants</p>
                    </div>
                  </div>
                </section>
              ) : null}

              <section className={`${dashboardPanelClass} p-5`}>
                <h3 className="text-sm font-semibold mb-1 flex items-center gap-2 text-gray-900 dark:text-white">
                  <GitCommitVertical className="w-4 h-4 text-indigo-500" /> Base chain
                </h3>
                <p className="text-[11px] text-gray-500 dark:text-gray-400 mb-3">
                  Relative-ref chain down to a primitive · click a resolved step to open it.
                </p>
                <ol className="relative ml-1.5 border-l border-gray-200 dark:border-gray-700 space-y-4 text-xs">
                  {baseChain.map((node, index) => {
                    // The head node is this type itself, so only the ref steps link anywhere.
                    const nodeHref = baseChainNodeHref(node);
                    return (
                    <li key={`${node.label}-${index}`} className="pl-4 relative">
                      <span
                        className={`absolute -left-[5px] top-1 w-2.5 h-2.5 rounded-full ${
                          node.kind === 'self'
                            ? 'bg-teal-500'
                            : node.status === 'unresolved'
                              ? 'bg-amber-500'
                              : 'bg-indigo-500'
                        }`}
                      />
                      {nodeHref ? (
                        <Link
                          href={nodeHref}
                          data-testid={`base-chain-link-${index}`}
                          title={baseChainNodeLabel(node)}
                          aria-label={baseChainNodeLabel(node)}
                          className="font-mono font-medium text-gray-700 dark:text-gray-200 underline decoration-dotted underline-offset-2 hover:decoration-solid focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500 rounded"
                        >
                          {node.label}
                        </Link>
                      ) : (
                        <p className="font-mono font-medium text-gray-700 dark:text-gray-200">{node.label}</p>
                      )}
                      <p className="text-[10px] text-gray-400 font-mono">
                        {node.kind === 'self'
                          ? `${primitive.category} · this type`
                          : node.target
                            ? `→ ${node.target}${node.status === 'unresolved' ? ' · unresolved' : ''}`
                            : 'unresolved'}
                      </p>
                    </li>
                    );
                  })}
                </ol>
              </section>
            </div>
          </div>
        ) : null}
      </main>
    </>
  );
}
