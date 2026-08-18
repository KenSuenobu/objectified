'use client';

/**
 * Guide editor — custom rules tab (GOV-2.3, #4435)
 *
 * Monaco YAML editor with JSON-schema completion (rule ids, given, then, functions) and
 * inline validation markers; right-hand "Test against…" pane dry-runs the draft YAML against
 * a project revision without persisting.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import dynamic from 'next/dynamic';
import type { Monaco } from '@monaco-editor/react';
import type { editor } from 'monaco-editor';
import {
  AlertCircle,
  AlertTriangle,
  BadgeCheck,
  CircleAlert,
  Play,
  RefreshCw,
} from 'lucide-react';
import customRuleDslSchema from '../custom-rule-dsl.schema.json';
import {
  fetchMyPermissions,
  fetchProjectOptions,
  fetchVersionOptions,
  styleGuidesApi,
  styleGuidesApiWithValidation,
  type CustomRulesPreviewResult,
  type GuideCustomRulesView,
  type ProjectOption,
  type VersionOption,
} from '../api';
import {
  parseValidationDetail,
  pointerToYamlRange,
  YAML_ERROR_MARKER_SEVERITY,
} from '../customRuleYamlMarkers';
import { CODE_EDITOR_FONT_SIZE } from '@/app/components/ui/code/editorTypography';
import { useUnsavedChangesPrompt } from '@/app/hooks/useUnsavedChangesPrompt';

const CUSTOM_RULES_MODEL_URI = 'inmemory://model/custom-rules.yaml';
const VALIDATION_MARKER_OWNER = 'apiome-custom-rules-validation';

const Editor = dynamic(() => import('@monaco-editor/react'), { ssr: false });

let monacoYamlConfigured = false;

function ensureMonacoYaml(monaco: Monaco) {
  if (monacoYamlConfigured || typeof window === 'undefined') return;
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { configureMonacoYaml } = require('monaco-yaml') as typeof import('monaco-yaml');
    configureMonacoYaml(monaco, {
      enableSchemaRequest: false,
      hover: true,
      completion: true,
      validate: true,
      schemas: [
        {
          uri: 'https://apiome.dev/schemas/custom-rule-dsl.json',
          fileMatch: [CUSTOM_RULES_MODEL_URI, '**/*custom-rules*.yaml', '**/*custom-rules*.yml'],
          schema: customRuleDslSchema,
        },
      ],
    });
    monacoYamlConfigured = true;
  } catch {
    // monaco-yaml worker setup can fail in some test/SSR environments; schema completion degrades.
  }
}

const inputClasses =
  'rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm text-gray-900 ' +
  'focus:outline-none focus:ring-2 focus:ring-indigo-500 dark:border-slate-700 dark:bg-slate-900 dark:text-white';

const severityIcon = {
  error: CircleAlert,
  warning: AlertTriangle,
  info: AlertCircle,
} as const;

export default function CustomRulesTab({ guideId }: { guideId: string }) {
  const [view, setView] = useState<GuideCustomRulesView | null>(null);
  const [draft, setDraft] = useState('');
  const [baseline, setBaseline] = useState('');
  const [isAdmin, setIsAdmin] = useState(false);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [previewing, setPreviewing] = useState(false);
  const [error, setError] = useState('');
  const [validationMessage, setValidationMessage] = useState('');

  const [projects, setProjects] = useState<ProjectOption[]>([]);
  const [versions, setVersions] = useState<VersionOption[]>([]);
  const [projectId, setProjectId] = useState('');
  const [versionRecordId, setVersionRecordId] = useState('');
  const [preview, setPreview] = useState<CustomRulesPreviewResult | null>(null);

  const editorRef = useRef<editor.IStandaloneCodeEditor | null>(null);
  const monacoRef = useRef<Monaco | null>(null);

  const readOnly = !isAdmin || view?.source === 'builtin';
  const dirty = draft !== baseline;

  const applyValidationMarker = useCallback((message: string, pointer: string, yaml: string) => {
    const ed = editorRef.current;
    const monaco = monacoRef.current;
    const model = ed?.getModel();
    if (!ed || !monaco || !model) return;
    const range = pointerToYamlRange(pointer, yaml);
    monaco.editor.setModelMarkers(model, VALIDATION_MARKER_OWNER, [
      {
        severity: YAML_ERROR_MARKER_SEVERITY,
        message,
        startLineNumber: range.startLine,
        startColumn: range.startColumn,
        endLineNumber: range.endLine,
        endColumn: range.endColumn,
      },
    ]);
  }, []);

  const clearValidationMarkers = useCallback(() => {
    const model = editorRef.current?.getModel();
    const monaco = monacoRef.current;
    if (!model || !monaco) return;
    monaco.editor.setModelMarkers(model, VALIDATION_MARKER_OWNER, []);
  }, []);

  const loadData = useCallback(async () => {
    setError('');
    setLoading(true);
    try {
      const [customView, perms, projectList] = await Promise.all([
        styleGuidesApi<GuideCustomRulesView>(`${guideId}/custom-rules`),
        fetchMyPermissions(),
        fetchProjectOptions(),
      ]);
      if (customView) {
        setView(customView);
        setDraft(customView.yaml);
        setBaseline(customView.yaml);
      }
      setIsAdmin(!!perms?.is_admin);
      setProjects(projectList);
      if (projectList.length > 0) {
        setProjectId((prev) => prev || projectList[0].id);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load custom rules');
    } finally {
      setLoading(false);
    }
  }, [guideId]);

  useEffect(() => {
    void loadData();
  }, [loadData]);

  useEffect(() => {
    if (!projectId) {
      setVersions([]);
      setVersionRecordId('');
      return;
    }
    let cancelled = false;
    void fetchVersionOptions(projectId).then((list) => {
      if (cancelled) return;
      setVersions(list);
      setVersionRecordId(list[0]?.id ?? '');
    });
    return () => {
      cancelled = true;
    };
  }, [projectId]);

  useUnsavedChangesPrompt(dirty);

  const handleEditorMount = useCallback(
    (ed: editor.IStandaloneCodeEditor, monaco: Monaco) => {
      editorRef.current = ed;
      monacoRef.current = monaco;
      ensureMonacoYaml(monaco);
      const model = ed.getModel();
      if (model && model.uri.toString() !== CUSTOM_RULES_MODEL_URI) {
        const next = monaco.editor.createModel(
          model.getValue(),
          'yaml',
          monaco.Uri.parse(CUSTOM_RULES_MODEL_URI),
        );
        ed.setModel(next);
        model.dispose?.();
      }
    },
    [],
  );

  const handleDiscard = () => {
    setDraft(baseline);
    setValidationMessage('');
    clearValidationMarkers();
    setPreview(null);
  };

  const handleSave = async () => {
    setSaving(true);
    setError('');
    setValidationMessage('');
    clearValidationMarkers();
    try {
      const saved = await styleGuidesApiWithValidation<GuideCustomRulesView>(
        `${guideId}/custom-rules`,
        {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ yaml: draft }),
        },
      );
      if (saved) {
        setView(saved);
        setBaseline(saved.yaml);
        setDraft(saved.yaml);
      }
    } catch (e) {
      const detail = parseValidationDetail(
        (e as Error & { detail?: unknown }).detail ?? e,
      );
      if (detail?.message) {
        setValidationMessage(detail.message);
        applyValidationMarker(detail.message, detail.pointer ?? '', draft);
      } else {
        setError(e instanceof Error ? e.message : 'Failed to save custom rules');
      }
    } finally {
      setSaving(false);
    }
  };

  const handlePreview = async () => {
    if (!projectId || !versionRecordId) return;
    setPreviewing(true);
    setError('');
    setValidationMessage('');
    clearValidationMarkers();
    try {
      const result = await styleGuidesApiWithValidation<CustomRulesPreviewResult>(
        `${guideId}/custom-rules/preview`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            yaml: draft,
            projectId,
            versionRecordId,
          }),
        },
      );
      setPreview(result);
    } catch (e) {
      const detail = parseValidationDetail(
        (e as Error & { detail?: unknown }).detail ?? e,
      );
      if (detail?.message) {
        setValidationMessage(detail.message);
        applyValidationMarker(detail.message, detail.pointer ?? '', draft);
      } else {
        setError(e instanceof Error ? e.message : 'Preview failed');
      }
      setPreview(null);
    } finally {
      setPreviewing(false);
    }
  };

  const previewFindings = preview?.findings ?? [];
  const canRunPreview = !!projectId && !!versionRecordId && !previewing;

  const selectedVersionLabel = useMemo(
    () => versions.find((v) => v.id === versionRecordId)?.label ?? '',
    [versions, versionRecordId],
  );

  return (
    <>
      {error && (
        <div className="mb-4 flex items-start gap-3 rounded-lg border border-rose-300 bg-rose-50 p-4 text-rose-700 dark:border-rose-800 dark:bg-rose-900/20 dark:text-rose-300">
          <AlertCircle className="mt-0.5 h-5 w-5 flex-shrink-0" />
          <p className="text-sm">{error}</p>
        </div>
      )}

      {validationMessage && (
        <div className="mb-4 flex items-start gap-3 rounded-lg border border-amber-300 bg-amber-50 p-4 text-amber-800 dark:border-amber-700 dark:bg-amber-900/30 dark:text-amber-200">
          <AlertTriangle className="mt-0.5 h-5 w-5 flex-shrink-0" />
          <p className="text-sm">{validationMessage}</p>
        </div>
      )}

      {view && readOnly && (
        <div className="mb-4 flex items-start gap-3 rounded-lg border border-slate-300 bg-slate-100 p-4 text-slate-700 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-300">
          <AlertCircle className="mt-0.5 h-5 w-5 flex-shrink-0" />
          <p className="text-sm">
            {view.source === 'builtin'
              ? 'The built-in “Apiome Recommended” guide is read-only. Duplicate it from the Style Guides list to author custom rules.'
              : 'Only tenant administrators can edit custom rules. You can preview violations.'}
          </p>
        </div>
      )}

      {loading ? (
        <div className="flex items-center justify-center py-24">
          <RefreshCw className="h-8 w-8 animate-spin text-gray-400" />
        </div>
      ) : !view ? (
        <div className="rounded-xl border border-slate-200 bg-white p-12 text-center dark:border-slate-800 dark:bg-slate-900">
          <p className="text-sm text-gray-500 dark:text-gray-400">Style guide not found.</p>
        </div>
      ) : (
        <div className="grid min-h-[32rem] grid-cols-1 gap-4 lg:grid-cols-2">
          <section
            aria-label="Custom rules YAML editor"
            className="flex min-h-96 flex-col overflow-hidden rounded-xl border border-slate-200 bg-white dark:border-slate-800 dark:bg-slate-900"
          >
            <header className="border-b border-slate-200 px-4 py-2 text-sm font-medium text-gray-700 dark:border-slate-800 dark:text-gray-300">
              Custom rules (YAML)
              <span className="ml-2 font-normal text-gray-400">
                {view.ruleCount} rule{view.ruleCount === 1 ? '' : 's'} saved
              </span>
            </header>
            <div className="min-h-0 flex-1">
              <Editor
                height="100%"
                language="yaml"
                path={CUSTOM_RULES_MODEL_URI}
                value={draft}
                onChange={(value) => setDraft(value ?? '')}
                onMount={handleEditorMount}
                options={{
                  readOnly: readOnly || saving,
                  minimap: { enabled: false },
                  fontSize: CODE_EDITOR_FONT_SIZE,
                  wordWrap: 'on',
                  scrollBeyondLastLine: false,
                  automaticLayout: true,
                }}
              />
            </div>
          </section>

          <section
            aria-label="Test against preview"
            className="flex min-h-96 flex-col overflow-hidden rounded-xl border border-slate-200 bg-white dark:border-slate-800 dark:bg-slate-900"
          >
            <header className="border-b border-slate-200 px-4 py-3 dark:border-slate-800">
              <h3 className="text-sm font-medium text-gray-700 dark:text-gray-300">Test against…</h3>
              <div className="mt-3 flex flex-wrap items-end gap-2">
                <label className="min-w-40 flex-1 text-xs text-gray-500 dark:text-gray-400">
                  Project
                  <select
                    aria-label="Preview project"
                    value={projectId}
                    onChange={(e) => setProjectId(e.target.value)}
                    className={`${inputClasses} mt-1 w-full`}
                  >
                    {projects.length === 0 && <option value="">No projects</option>}
                    {projects.map((p) => (
                      <option key={p.id} value={p.id}>
                        {p.name}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="min-w-40 flex-1 text-xs text-gray-500 dark:text-gray-400">
                  Version
                  <select
                    aria-label="Preview version"
                    value={versionRecordId}
                    onChange={(e) => setVersionRecordId(e.target.value)}
                    disabled={!projectId || versions.length === 0}
                    className={`${inputClasses} mt-1 w-full disabled:opacity-50`}
                  >
                    {versions.length === 0 && <option value="">No versions</option>}
                    {versions.map((v) => (
                      <option key={v.id} value={v.id}>
                        {v.label}
                      </option>
                    ))}
                  </select>
                </label>
                <button
                  type="button"
                  onClick={() => void handlePreview()}
                  disabled={!canRunPreview}
                  className="inline-flex items-center gap-2 rounded-lg bg-indigo-600 px-4 py-2 text-sm font-medium text-white hover:bg-indigo-700 disabled:opacity-50"
                >
                  <Play className="h-4 w-4" />
                  {previewing ? 'Running…' : 'Run'}
                </button>
              </div>
            </header>

            <div className="min-h-0 flex-1 overflow-y-auto p-4">
              {!preview ? (
                <p className="text-sm text-gray-500 dark:text-gray-400">
                  Pick a project and version, then <strong>Run</strong> to see violations from the
                  draft rules above — nothing is saved until you click Save.
                </p>
              ) : previewFindings.length === 0 ? (
                <p className="text-sm text-emerald-700 dark:text-emerald-300">
                  No violations — draft rules pass against{' '}
                  <span className="font-medium">{selectedVersionLabel}</span>.
                </p>
              ) : (
                <ul className="space-y-3">
                  {previewFindings.map((finding) => {
                    const Icon = severityIcon[finding.severity] ?? AlertCircle;
                    return (
                      <li
                        key={finding.id}
                        className="rounded-lg border border-slate-200 p-3 dark:border-slate-700"
                      >
                        <div className="flex items-start gap-2">
                          <Icon
                            className={`mt-0.5 h-4 w-4 flex-shrink-0 ${
                              finding.severity === 'error'
                                ? 'text-rose-600'
                                : finding.severity === 'warning'
                                  ? 'text-amber-600'
                                  : 'text-sky-600'
                            }`}
                          />
                          <div className="min-w-0">
                            <div className="flex flex-wrap items-center gap-2">
                              <code className="text-xs font-semibold text-gray-900 dark:text-white">
                                {finding.rule}
                              </code>
                              <span className="text-xs text-gray-500">{finding.path}</span>
                            </div>
                            <p className="mt-1 text-sm text-gray-600 dark:text-gray-300">
                              {finding.severity} — {finding.message}
                            </p>
                          </div>
                        </div>
                      </li>
                    );
                  })}
                </ul>
              )}

              {preview && Object.keys(preview.ruleErrors).length > 0 && (
                <div className="mt-4 rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900 dark:border-amber-800 dark:bg-amber-900/20 dark:text-amber-200">
                  <p className="font-medium">Rules aborted during evaluation</p>
                  <ul className="mt-2 list-disc pl-5">
                    {Object.entries(preview.ruleErrors).map(([ruleId, reason]) => (
                      <li key={ruleId}>
                        <code>{ruleId}</code>: {reason}
                      </li>
                    ))}
                  </ul>
                </div>
              )}
            </div>
          </section>
        </div>
      )}

      {dirty && (
        <div
          role="status"
          className="sticky bottom-0 mt-4 flex items-center justify-between gap-4 border-t border-amber-300 bg-amber-50 px-6 py-3 dark:border-amber-700 dark:bg-amber-900/30"
        >
          <span className="flex items-center gap-2 text-sm font-medium text-amber-800 dark:text-amber-200">
            <BadgeCheck className="h-4 w-4" />
            Unsaved custom rules
          </span>
          <div className="flex gap-2">
            <button
              type="button"
              onClick={handleDiscard}
              disabled={saving}
              className="rounded-lg border border-slate-300 px-4 py-2 text-sm text-gray-700 hover:bg-white disabled:opacity-50 dark:border-slate-600 dark:text-gray-200 dark:hover:bg-slate-800"
            >
              Discard
            </button>
            <button
              type="button"
              onClick={() => void handleSave()}
              disabled={saving || readOnly}
              className="rounded-lg bg-indigo-600 px-4 py-2 text-sm font-medium text-white hover:bg-indigo-700 disabled:opacity-50"
            >
              {saving ? 'Saving…' : 'Save'}
            </button>
          </div>
        </div>
      )}
    </>
  );
}
