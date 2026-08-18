'use client';

import * as React from 'react';
import dynamic from 'next/dynamic';
import type { Monaco } from '@monaco-editor/react';
import type { editor } from 'monaco-editor';
import {
  CircleAlert,
  FileCode2,
  FlaskConical,
  Info,
  OctagonAlert,
  Play,
  Plus,
  TriangleAlert,
  WandSparkles,
} from 'lucide-react';

import { Alert } from '@/app/components/ui/Alert';
import { Badge } from '@/app/components/ui/Badge';
import { Button } from '@/app/components/ui/Button';
import { Card, CardContent, CardHeader } from '@/app/components/ui/Card';
import { Label } from '@/app/components/ui/Label';
import { Skeleton } from '@/app/components/ui/Skeleton';
import { Spinner } from '@/app/components/ui/Spinner';
import { CODE_EDITOR_FONT_SIZE } from '@/app/components/ui/code/editorTypography';
import { useHiveMonacoTheme } from '@/app/components/ui/code/monacoHiveTheme';

import customRuleDslSchema from '@/app/ade/dashboard/style-guides/custom-rule-dsl.schema.json';
import {
  MARKER_SEVERITY,
  YAML_ERROR_MARKER_SEVERITY,
  pointerToYamlRange,
  previewMarkers,
} from '@/app/ade/dashboard/style-guides/customRuleYamlMarkers';
import type { CustomRulePreviewFinding } from '@/app/ade/dashboard/style-guides/api';

import GuideReadOnlyNotice from './GuideReadOnlyNotice';
import GuideSaveBar from './GuideSaveBar';
import type { GuideReadOnlyReason } from './guideDetailModel';
import type { CustomRulesState } from './guideEditorState';

/**
 * The custom-rules tab — HIVE-5.7 (#5310).
 *
 * Authority: `docs/mockups/govern/style-guide-detail.html`, its second panel.
 *
 * ### What changed
 *
 * The editor had, in the ticket's words, *no visual relationship to the rest of the app*: a
 * `vs-dark` Monaco in a `border-slate-200` box, on a page painted in warm paper. Two things
 * fix that, and both are acceptance criteria:
 *
 *   * **The editor is painted in the Hive palette** — `useHiveMonacoTheme` resolves the
 *     tokens from the live document and follows every theme swap. It is built as a shared
 *     module rather than as part of this screen because HIVE-6.4 and 8.3 inherit it.
 *   * **A dry run leaves marks in the editor.** Findings used to be a list beside the code
 *     with no line to point at; each one now also becomes a Monaco marker on the rule that
 *     produced it, and clicking a finding scrolls the editor to that rule. That is the loop
 *     the tab exists for: write a rule, run it, see where it fired, fix it.
 *
 * The document itself lives in `useCustomRules` on the page, so switching to the catalog and
 * back does not lose an unsaved draft — the failure the problem statement names.
 */

/** The model URI the YAML schema is matched against. */
const CUSTOM_RULES_MODEL_URI = 'inmemory://model/custom-rules.yaml';

/** Marker owner for the server's own complaint about the document. */
const VALIDATION_MARKER_OWNER = 'apiome-custom-rules-validation';

/** Marker owner for the last dry run's findings. Separate, so clearing one keeps the other. */
const PREVIEW_MARKER_OWNER = 'apiome-custom-rules-preview';

/** What "Insert rule snippet" writes at the cursor. */
const RULE_SNIPPET = [
  '  my-new-rule:',
  '    description: What this rule insists on, and why.',
  '    severity: warning',
  '    given: $.paths[*][*].summary',
  '    then:',
  '      function: length',
  '      functionOptions: { max: 60 }',
  '',
].join('\n');

const Editor = dynamic(() => import('@monaco-editor/react'), { ssr: false });

/** Whether `monaco-yaml` has already been configured for this page load. */
let monacoYamlConfigured = false;

/**
 * Give Monaco the custom-rule DSL schema, once per page load.
 *
 * @param monaco The Monaco namespace.
 */
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
    // The monaco-yaml worker cannot start in some test and SSR environments; schema
    // completion degrades to a plain YAML editor rather than taking the tab down.
  }
}

/** The glyph each severity leads its finding with. */
const SEVERITY_ICON = {
  error: CircleAlert,
  warning: TriangleAlert,
  info: Info,
} as const;

/** Props for {@link CustomRulesTab}. */
export interface CustomRulesTabProps {
  /** The document, the dry run and their writes, from `useCustomRules`. */
  state: CustomRulesState;
  /** Why the guide cannot be edited, or `null`. */
  readOnlyReason: GuideReadOnlyReason;
}

/**
 * The custom-rules editor and its dry-run pane.
 *
 * @param props See {@link CustomRulesTabProps}.
 * @returns The two panes and the save bar.
 */
export default function CustomRulesTab({ state, readOnlyReason }: CustomRulesTabProps) {
  const editorRef = React.useRef<editor.IStandaloneCodeEditor | null>(null);
  const monacoRef = React.useRef<Monaco | null>(null);
  const monacoTheme = useHiveMonacoTheme();

  const readOnly = readOnlyReason !== null;
  const findings = React.useMemo(() => state.preview?.findings ?? [], [state.preview]);
  const ruleErrors = React.useMemo(() => state.preview?.ruleErrors ?? {}, [state.preview]);
  const problemCount = findings.length + Object.keys(ruleErrors).length;

  /**
   * Replace one owner's markers on the open model.
   *
   * @param owner Which set of markers is being replaced.
   * @param markers The new set — an empty array clears them.
   */
  const setMarkers = React.useCallback(
    (owner: string, markers: editor.IMarkerData[]) => {
      const model = editorRef.current?.getModel();
      const monaco = monacoRef.current;
      if (!model || !monaco) return;
      monaco.editor.setModelMarkers(model, owner, markers);
    },
    []
  );

  // The server's complaint about the document, as an inline squiggle at the pointer it
  // named. Re-applied whenever it changes, and cleared when it is answered.
  React.useEffect(() => {
    const detail = state.validation;
    if (!detail?.message) {
      setMarkers(VALIDATION_MARKER_OWNER, []);
      return;
    }
    const range = pointerToYamlRange(detail.pointer ?? '', state.draft);
    setMarkers(VALIDATION_MARKER_OWNER, [
      {
        severity: YAML_ERROR_MARKER_SEVERITY,
        message: detail.message,
        startLineNumber: range.startLine,
        startColumn: range.startColumn,
        endLineNumber: range.endLine,
        endColumn: range.endColumn,
      },
    ]);
  }, [setMarkers, state.draft, state.validation]);

  // The dry run's findings, as markers on the rules that produced them — the ticket's third
  // acceptance criterion.
  React.useEffect(() => {
    if (!state.preview) {
      setMarkers(PREVIEW_MARKER_OWNER, []);
      return;
    }
    setMarkers(
      PREVIEW_MARKER_OWNER,
      previewMarkers(findings, ruleErrors, state.draft).map((marker) => ({
        severity: marker.severity,
        message: marker.message,
        source: marker.source,
        startLineNumber: marker.startLine,
        startColumn: marker.startColumn,
        endLineNumber: marker.endLine,
        endColumn: marker.endColumn,
      }))
    );
  }, [findings, ruleErrors, setMarkers, state.draft, state.preview]);

  const handleEditorMount = React.useCallback(
    (instance: editor.IStandaloneCodeEditor, monaco: Monaco) => {
      editorRef.current = instance;
      monacoRef.current = monaco;
      ensureMonacoYaml(monaco);
      // The schema is matched by model URI, so a model the wrapper named after the `path`
      // prop has to be replaced with one at the URI `fileMatch` lists.
      const model = instance.getModel();
      if (model && model.uri.toString() !== CUSTOM_RULES_MODEL_URI) {
        const next = monaco.editor.createModel(
          model.getValue(),
          'yaml',
          monaco.Uri.parse(CUSTOM_RULES_MODEL_URI)
        );
        instance.setModel(next);
        model.dispose?.();
      }
    },
    []
  );

  /** Scroll the editor to the rule a finding came from, and put the cursor on it. */
  const revealRule = React.useCallback(
    (ruleId: string) => {
      const instance = editorRef.current;
      if (!instance) return;
      const range = pointerToYamlRange(`rules.${ruleId}`, state.draft);
      instance.revealLineInCenter?.(range.startLine);
      instance.setPosition?.({ lineNumber: range.startLine, column: range.startColumn });
      instance.focus?.();
    },
    [state.draft]
  );

  /** Run Monaco's own formatter over the document. */
  const formatDocument = React.useCallback(() => {
    void editorRef.current?.getAction?.('editor.action.formatDocument')?.run();
  }, []);

  /** Append a rule skeleton, so a first custom rule is not a blank page. */
  const { draft, setDraft } = state;
  const insertSnippet = React.useCallback(() => {
    const base = draft.trimEnd();
    setDraft(base ? `${base}\n${RULE_SNIPPET}` : `rules:\n${RULE_SNIPPET}`);
  }, [draft, setDraft]);

  if (state.loading) {
    return (
      <div className="gd-editor-layout" data-testid="custom-rules-loading">
        <span className="sr-only" role="status">
          Loading the custom rules…
        </span>
        <Skeleton className="gd-skeleton__editor" />
        <Skeleton className="gd-skeleton__editor" />
      </div>
    );
  }

  return (
    <div className="gd-panel">
      <GuideReadOnlyNotice reason={readOnlyReason} surface="custom-rules" />

      {state.error && (
        <Alert variant="error" onClose={state.clearError} data-testid="custom-rules-error">
          {state.error}
        </Alert>
      )}

      <div className="gd-editor-layout">
        <Card className="gd-editor-card">
          <CardHeader className="gd-editor-head">
            <div className="gd-editor-head__text">
              <h3 className="gd-card-title">
                <FileCode2 aria-hidden className="gd-card-title__glyph" />
                Custom rules (YAML)
              </h3>
              <p className="sg-quiet">
                {state.view?.ruleCount ?? 0} rule{state.view?.ruleCount === 1 ? '' : 's'} saved
                {' · '}Spectral-compatible subset · schema completion from{' '}
                <code className="mono">custom-rule-dsl.schema.json</code>
              </p>
            </div>
            {!readOnly && (
              <div className="gd-editor-head__actions">
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={formatDocument}
                  data-testid="custom-rules-format"
                >
                  <WandSparkles aria-hidden />
                  Format
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={insertSnippet}
                  data-testid="custom-rules-snippet"
                >
                  <Plus aria-hidden />
                  Insert rule
                </Button>
              </div>
            )}
          </CardHeader>

          {/* The server's own complaint about the document, in full, above the code it is
              about. The same message is also a marker on the line the pointer named. */}
          {state.validation?.message && (
            <Alert
              variant="warning"
              className="gd-editor-banner"
              data-testid="custom-rules-validation"
            >
              <strong>Server validation failed.</strong> {state.validation.message}
            </Alert>
          )}

          <div className="gd-editor">
            <Editor
              height="100%"
              language="yaml"
              path={CUSTOM_RULES_MODEL_URI}
              theme={monacoTheme.theme}
              beforeMount={monacoTheme.beforeMount}
              value={state.draft}
              onChange={(value) => state.setDraft(value ?? '')}
              onMount={handleEditorMount}
              options={{
                readOnly: readOnly || state.saving,
                minimap: { enabled: false },
                fontSize: CODE_EDITOR_FONT_SIZE,
                wordWrap: 'on',
                scrollBeyondLastLine: false,
                automaticLayout: true,
                padding: { top: 8, bottom: 8 },
              }}
            />
          </div>

          <div className="gd-editor-status" data-testid="custom-rules-status">
            <span>YAML</span>
            <span aria-hidden>·</span>
            <span>
              {problemCount === 0
                ? 'No problems'
                : `${problemCount} problem${problemCount === 1 ? '' : 's'}`}
            </span>
            <span className="gd-editor-status__spacer" />
            <span>{state.dirty ? 'Draft — unsaved' : 'Saved'}</span>
          </div>
        </Card>

        <Card className="gd-preview-card">
          <CardHeader className="gd-editor-head">
            <div className="gd-editor-head__text">
              <h3 className="gd-card-title">
                <FlaskConical aria-hidden className="gd-card-title__glyph" />
                Test against…
              </h3>
              <p className="sg-quiet">dry run · nothing is saved</p>
            </div>
          </CardHeader>

          <CardContent className="gd-preview-body">
            <div className="gd-preview-picker">
              <div className="sg-field">
                <Label htmlFor="custom-rules-project">Project</Label>
                <select
                  id="custom-rules-project"
                  aria-label="Preview project"
                  className="hive-control sg-select"
                  value={state.projectId}
                  onChange={(event) => state.setProjectId(event.target.value)}
                >
                  {state.projects.length === 0 && <option value="">No projects</option>}
                  {state.projects.map((project) => (
                    <option key={project.id} value={project.id}>
                      {project.name}
                    </option>
                  ))}
                </select>
              </div>
              <div className="sg-field">
                <Label htmlFor="custom-rules-version">Version</Label>
                <select
                  id="custom-rules-version"
                  aria-label="Preview version"
                  className="hive-control sg-select"
                  value={state.versionRecordId}
                  disabled={!state.projectId || state.versions.length === 0}
                  onChange={(event) => state.setVersionRecordId(event.target.value)}
                >
                  {state.versions.length === 0 && <option value="">No versions</option>}
                  {state.versions.map((version) => (
                    <option key={version.id} value={version.id}>
                      {version.label}
                    </option>
                  ))}
                </select>
              </div>
            </div>

            <div className="gd-preview-run">
              <Button
                disabled={!state.projectId || !state.versionRecordId || state.previewing}
                onClick={() => void state.runPreview()}
                data-testid="custom-rules-run"
              >
                {state.previewing ? <Spinner size="sm" aria-hidden /> : <Play aria-hidden />}
                {state.previewing ? 'Running…' : 'Run'}
              </Button>
              {state.runMeta && (
                <span className="sg-quiet" data-testid="custom-rules-run-meta">
                  Last run {state.runMeta.at} · {state.runMeta.seconds} s
                  {state.runMeta.target ? ` · ${state.runMeta.target}` : ''}
                </span>
              )}
            </div>

            {!state.preview ? (
              <p className="gd-preview-hint">
                Pick a project and version, then <strong>Run</strong> to see violations from
                the draft rules above — nothing is saved until you click Save.
              </p>
            ) : findings.length === 0 ? (
              <p className="gd-preview-hint" data-testid="custom-rules-clean">
                No violations — draft rules pass against the selected version.
              </p>
            ) : (
              <div className="gd-findings">
                <div className="gd-findings__head">
                  <span className="gd-findings__title">Findings</span>
                  <span className="gd-findings__counts">
                    {(['error', 'warning', 'info'] as const).map((severity) => {
                      const count = findings.filter((f) => f.severity === severity).length;
                      return count === 0 ? null : (
                        <Badge key={severity} status={severity}>
                          {count} {severity}
                          {count === 1 ? '' : 's'}
                        </Badge>
                      );
                    })}
                  </span>
                </div>
                <ul className="gd-findings__list">
                  {findings.map((finding) => (
                    <FindingRow
                      key={finding.id}
                      finding={finding}
                      onReveal={() => revealRule(finding.rule)}
                    />
                  ))}
                </ul>
              </div>
            )}

            {Object.keys(ruleErrors).length > 0 && (
              <Alert
                variant="warning"
                icon={<OctagonAlert aria-hidden className="mt-px size-4 shrink-0" />}
                data-testid="custom-rules-aborted"
              >
                <strong>Rules aborted during evaluation.</strong>
                <ul className="gd-aborted">
                  {Object.entries(ruleErrors).map(([ruleId, reason]) => (
                    <li key={ruleId}>
                      <code className="mono">{ruleId}</code>: {reason}
                    </li>
                  ))}
                </ul>
              </Alert>
            )}
          </CardContent>
        </Card>
      </div>

      {state.dirty && (
        <GuideSaveBar
          data-testid="custom-rules-save-bar"
          label="Unsaved custom rules"
          saving={state.saving}
          canSave={!readOnly}
          saveLabel="Save"
          onDiscard={state.discard}
          onSave={() => void state.save()}
        />
      )}
    </div>
  );
}

/**
 * One dry-run violation.
 *
 * A button rather than a list item with a click handler: it moves the editor's cursor, and
 * that is an action a keyboard has to be able to take.
 *
 * @param props.finding The violation.
 * @param props.onReveal Scroll the editor to the rule that produced it.
 * @returns The row.
 */
function FindingRow({
  finding,
  onReveal,
}: {
  finding: CustomRulePreviewFinding;
  onReveal: () => void;
}) {
  const Glyph = SEVERITY_ICON[finding.severity] ?? Info;
  return (
    <li className="gd-finding">
      <button
        type="button"
        className="gd-finding__button"
        onClick={onReveal}
        data-severity={finding.severity}
        data-marker-severity={MARKER_SEVERITY[finding.severity]}
        data-testid={`custom-rules-finding-${finding.id}`}
      >
        <Glyph aria-hidden className="gd-finding__glyph" />
        <span className="gd-finding__text">
          <span className="gd-finding__line">
            <code className="gd-finding__rule">{finding.rule}</code>
            <span className="gd-finding__path">{finding.path}</span>
          </span>
          <span className="gd-finding__message">
            {finding.severity} — {finding.message}
          </span>
        </span>
      </button>
    </li>
  );
}
