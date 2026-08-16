'use client';

import * as React from 'react';
import dynamic from 'next/dynamic';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
  DialogDescription,
} from '@/app/components/ui/Dialog';
import { Label } from '@/app/components/ui/Label';
import { Input } from '@/app/components/ui/Input';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/app/components/ui/Select';
import {
  type MigrationRule,
  type MigrationRuleType,
} from '../MigrationContext';
import { Play, AlertCircle, BookOpen } from 'lucide-react';
import { cn } from '@lib/utils';
import { CODE_EDITOR_FONT_SIZE } from '@/app/components/ui/code/editorTypography';

const MonacoEditor = dynamic(() => import('@monaco-editor/react'), { ssr: false });

export interface MigrationRuleTemplate {
  id: string;
  name: string;
  description: string | null;
  category: string;
  rule_type: 'simple' | 'script' | 'sparkSql';
  rule_content: string;
  min_inputs: number;
  min_outputs: number;
  input_labels: string[] | null;
  sort_order: number;
}

/** Substitute template placeholders (value, a, b, c) with actual input property names. */
function substituteTemplateContent(
  content: string,
  inputNames: string[]
): string {
  if (inputNames.length === 0) return content;
  let out = content;
  const placeholders = ['value', 'a', 'b', 'c'];
  for (let i = 0; i < placeholders.length && i < inputNames.length; i++) {
    const re = new RegExp(`\\b${placeholders[i]}\\b`, 'g');
    out = out.replace(re, inputNames[i]!);
  }
  return out;
}

export interface MigrationRuleDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Edge id this rule is for (e.g. migration-edge-prop-zipcode). */
  edgeId: string;
  /** Default source property when adding a rule from this edge. */
  defaultSourceProp: string;
  /** Default target property when adding a rule from this edge. */
  defaultTargetProp: string;
  /** Source (from) class property names. */
  fromProperties: Array<{ name: string; type?: string }>;
  /** Target (to) class property names. */
  toProperties: Array<{ name: string; type?: string }>;
  /** Existing rule if editing. */
  initialRule?: MigrationRule | null;
  onSave: (rule: MigrationRule) => void;
}

const RULE_TYPE_OPTIONS: { value: MigrationRuleType; label: string }[] = [
  { value: 'simple', label: 'Simple expression' },
  { value: 'script', label: 'Script' },
  { value: 'sparkSql', label: 'SparkSQL' },
];

function tryEvaluateRule(
  rule: Pick<MigrationRule, 'ruleType' | 'ruleContent' | 'inputProperties' | 'outputProperties'>,
  inputValues: Record<string, string>
): { ok: true; outputs: unknown[] } | { ok: false; error: string } {
  const { ruleType, ruleContent, inputProperties, outputProperties } = rule;
  const orderedInputs = inputProperties.map((p) => inputValues[p] ?? '');

  if (ruleType === 'sparkSql') {
    return { ok: false, error: 'SparkSQL rules cannot be tested in the browser. Run in Spark to validate.' };
  }

  try {
    if (ruleType === 'simple') {
      if (!ruleContent.trim()) {
        return { ok: false, error: 'Enter an expression.' };
      }
      const fn = new Function(...inputProperties, `return (${ruleContent});`);
      const result = fn(...orderedInputs);
      if (outputProperties.length === 1) {
        const out = result === undefined ? '' : String(result);
        return { ok: true, outputs: [out] };
      }
      const arr = Array.isArray(result) ? result : [result];
      const outputs = outputProperties.map((_, i) => (arr[i] === undefined ? '' : String(arr[i])));
      return { ok: true, outputs };
    }

    if (ruleType === 'script') {
      if (!ruleContent.trim()) {
        return { ok: false, error: 'Enter script body with a return statement.' };
      }
      const fn = new Function(...inputProperties, ruleContent);
      const result = fn(...orderedInputs);
      if (outputProperties.length === 1) {
        const out = result === undefined ? '' : String(result);
        return { ok: true, outputs: [out] };
      }
      const arr = Array.isArray(result) ? result : (result && typeof result === 'object' && outputProperties.every((p) => p in (result as object))
        ? outputProperties.map((p) => (result as Record<string, unknown>)[p])
        : [result]);
      const outputs = outputProperties.map((_, i) => (arr[i] === undefined ? '' : String(arr[i])));
      return { ok: true, outputs };
    }

    return { ok: false, error: 'Unknown rule type.' };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { ok: false, error: message };
  }
}

export default function MigrationRuleDialog({
  open,
  onOpenChange,
  edgeId,
  defaultSourceProp,
  defaultTargetProp,
  fromProperties,
  toProperties,
  initialRule,
  onSave,
}: MigrationRuleDialogProps) {
  const [inputProperties, setInputProperties] = React.useState<string[]>(() =>
    initialRule ? [...initialRule.inputProperties] : [defaultSourceProp]
  );
  const [outputProperties, setOutputProperties] = React.useState<string[]>(() =>
    initialRule ? [...initialRule.outputProperties] : [defaultTargetProp]
  );
  const [ruleName, setRuleName] = React.useState(initialRule?.name ?? '');
  const [ruleType, setRuleType] = React.useState<MigrationRuleType>(
    initialRule?.ruleType ?? 'simple'
  );
  const [ruleContent, setRuleContent] = React.useState(initialRule?.ruleContent ?? '');
  const [testInputValues, setTestInputValues] = React.useState<Record<string, string>>(() => {
    const init: Record<string, string> = {};
    const props = initialRule ? initialRule.inputProperties : [defaultSourceProp];
    props.forEach((p) => (init[p] = ''));
    return init;
  });
  const [testResult, setTestResult] = React.useState<
    { ok: true; outputs: unknown[] } | { ok: false; error: string } | null
 >(null);
  const [templates, setTemplates] = React.useState<MigrationRuleTemplate[]>([]);
  const [selectedTemplateId, setSelectedTemplateId] = React.useState<string | null>(null);

  const fromPropNames = fromProperties.map((p) => p.name);
  const toPropNames = toProperties.map((p) => p.name);
  const selectedTemplate = selectedTemplateId
    ? templates.find((t) => t.id === selectedTemplateId) ?? null
    : null;

  React.useEffect(() => {
    if (!open) return;
    setInputProperties(initialRule ? [...initialRule.inputProperties] : [defaultSourceProp]);
    setOutputProperties(initialRule ? [...initialRule.outputProperties] : [defaultTargetProp]);
    setRuleName(initialRule?.name ?? '');
    setRuleType(initialRule?.ruleType ?? 'simple');
    setRuleContent(initialRule?.ruleContent ?? '');
    setSelectedTemplateId(null);
    const init: Record<string, string> = {};
    (initialRule ? initialRule.inputProperties : [defaultSourceProp]).forEach((p) => (init[p] = ''));
    setTestInputValues(init);
    setTestResult(null);
  }, [open, edgeId, defaultSourceProp, defaultTargetProp, initialRule]);

  React.useEffect(() => {
    if (!open) return;
    fetch('/api/migration-rule-templates')
      .then((r) => r.json())
      .then((data) => (data.success && data.templates ? setTemplates(data.templates) : []))
      .catch(() => setTemplates([]));
  }, [open]);

  const applyTemplate = React.useCallback(
    (template: MigrationRuleTemplate) => {
      setRuleType(template.rule_type);
      const needInputs = Math.max(template.min_inputs, 1);
      const needOutputs = Math.max(template.min_outputs, 1);
      const newInputs: string[] = [defaultSourceProp];
      for (const n of fromPropNames) {
        if (newInputs.length >= needInputs) break;
        if (!newInputs.includes(n)) newInputs.push(n);
      }
      const newOutputs: string[] = [defaultTargetProp];
      for (const n of toPropNames) {
        if (newOutputs.length >= needOutputs) break;
        if (!newOutputs.includes(n)) newOutputs.push(n);
      }
      setInputProperties(newInputs);
      setOutputProperties(newOutputs);
      setRuleContent(substituteTemplateContent(template.rule_content, newInputs));
      setTestInputValues(
        newInputs.reduce<Record<string, string>>((acc, p) => ({ ...acc, [p]: '' }), {})
      );
    },
    [fromPropNames, toPropNames, defaultSourceProp, defaultTargetProp]
  );

  const onTemplateChange = (templateId: string) => {
    if (!templateId || templateId === 'custom') {
      setSelectedTemplateId(null);
      return;
    }
    const t = templates.find((x) => x.id === templateId);
    if (t) {
      setSelectedTemplateId(templateId);
      applyTemplate(t);
    }
  };

  const addInput = () => {
    const next = fromPropNames.find((n) => !inputProperties.includes(n));
    if (next) setInputProperties((prev) => [...prev, next]);
  };
  const removeInput = (name: string) => {
    setInputProperties((prev) => prev.filter((p) => p !== name));
    setTestInputValues((prev) => {
      const next = { ...prev };
      delete next[name];
      return next;
    });
  };
  const addOutput = () => {
    const next = toPropNames.find((n) => !outputProperties.includes(n));
    if (next) setOutputProperties((prev) => [...prev, next]);
  };
  const removeOutput = (name: string) => {
    setOutputProperties((prev) => prev.filter((p) => p !== name));
  };

  const handleRunTest = () => {
    const result = tryEvaluateRule(
      { ruleType, ruleContent, inputProperties, outputProperties },
      testInputValues
    );
    setTestResult(result);
  };

  const handleSave = () => {
    onSave({
      name: ruleName.trim() || undefined,
      inputProperties,
      ruleType,
      ruleContent: ruleContent.trim(),
      outputProperties,
    });
    onOpenChange(false);
  };

  const minInputs = selectedTemplate?.min_inputs ?? 1;
  const minOutputs = selectedTemplate?.min_outputs ?? 1;
  const inputsMet = inputProperties.length >= minInputs;
  const outputsMet = outputProperties.length >= minOutputs;
  const isValid =
    inputsMet &&
    outputsMet &&
    ruleContent.trim().length > 0;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="max-w-5xl w-[90vw] h-[90vh] flex flex-col overflow-hidden p-0 gap-0"
        showCloseButton
      >
        <DialogHeader className="shrink-0 px-6 pt-6 pb-2">
          <DialogTitle>{initialRule ? 'Edit migration rule' : 'Add migration rule'}</DialogTitle>
          <DialogDescription>
            Choose a template or write a custom rule. Define inputs and outputs, then edit the rule code. Test with sample values below.
          </DialogDescription>
        </DialogHeader>

        <div className="flex-1 min-h-0 flex flex-col overflow-hidden px-6 pb-4">
          {/* Rule template at top */}
          <div className="shrink-0 flex items-center gap-3 py-3 border-b border-gray-200 dark:border-gray-700">
            <Label className="flex items-center gap-2 shrink-0 text-sm font-medium text-gray-700 dark:text-gray-300">
              <BookOpen className="h-4 w-4 text-gray-500 dark:text-gray-400" />
              Rule template
            </Label>
            <Select value={selectedTemplateId ?? 'custom'} onValueChange={onTemplateChange}>
              <SelectTrigger className="w-[280px]">
                <SelectValue placeholder="Custom (no template)" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="custom">Custom (no template)</SelectItem>
                {templates.map((t) => (
                  <SelectItem key={t.id} value={t.id}>
                    {t.name}
                    {t.min_inputs > 1 || t.min_outputs > 1 ? (
                      <span className="ml-1.5 text-xs text-gray-500 dark:text-gray-400">
                        ({t.min_inputs} in → {t.min_outputs} out)
                      </span>
                    ) : null}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            {selectedTemplate?.description && (
              <p className="text-xs text-gray-500 dark:text-gray-400 truncate max-w-[240px]">
                {selectedTemplate.description}
              </p>
            )}
          </div>

          {/* Rule name: shown on the canvas in place of "+" when a rule is applied */}
          <div className="space-y-2">
            <Label className="text-sm font-medium">Rule name</Label>
            <Input
              value={ruleName}
              onChange={(e) => setRuleName(e.target.value)}
              placeholder="e.g. Split zipcode"
              className="max-w-xs font-medium"
            />
            <p className="text-xs text-gray-500 dark:text-gray-400">
              This name appears on the migration canvas. Leave empty for passthrough (no rule).
            </p>
          </div>

          {/* 50/50: Left = inputs/outputs, Right = rule code (Monaco) */}
          <div className="flex-1 min-h-0 flex gap-4 py-3 overflow-hidden">
            <div className="w-1/2 min-w-0 flex flex-col gap-4 overflow-y-auto border border-gray-200 dark:border-gray-700 rounded-lg p-4 bg-gray-50/50 dark:bg-gray-800/30">
              <div className="space-y-2">
                <Label className="text-sm font-medium">Inputs (source properties)</Label>
                {selectedTemplate && selectedTemplate.min_inputs > 1 && (
                  <p className="text-xs text-amber-600 dark:text-amber-400">
                    At least {selectedTemplate.min_inputs} inputs required.
                  </p>
                )}
                <div className="flex flex-wrap gap-2">
                  {inputProperties.map((name) => (
                    <span
                      key={name}
                      className="inline-flex items-center gap-1 rounded-md border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-800 px-2 py-1 text-sm"
                    >
                      {name}
                      <button
                        type="button"
                        onClick={() => removeInput(name)}
                        className="text-gray-500 hover:text-gray-900 dark:hover:text-gray-200"
                        aria-label={`Remove ${name}`}
                      >
                        ×
                      </button>
                    </span>
                  ))}
                  {inputProperties.length < fromPropNames.length && (
                    <Select
                      value=""
                      onValueChange={(v) => {
                        if (v && !inputProperties.includes(v)) {
                          setInputProperties((prev) => [...prev, v]);
                          setTestInputValues((prev) => ({ ...prev, [v]: '' }));
                        }
                      }}
                    >
                      <SelectTrigger className="w-[120px] h-8">
                        <SelectValue placeholder="Add input" />
                      </SelectTrigger>
                      <SelectContent>
                        {fromPropNames
                          .filter((n) => !inputProperties.includes(n))
                          .map((n) => (
                            <SelectItem key={n} value={n}>
                              {n}
                            </SelectItem>
                          ))}
                      </SelectContent>
                    </Select>
                  )}
                </div>
              </div>
              <div className="space-y-2">
                <Label className="text-sm font-medium">Outputs (destination properties)</Label>
                {selectedTemplate && selectedTemplate.min_outputs > 1 && (
                  <p className="text-xs text-amber-600 dark:text-amber-400">
                    At least {selectedTemplate.min_outputs} outputs required.
                  </p>
                )}
                <div className="flex flex-wrap gap-2">
                  {outputProperties.map((name) => (
                    <span
                      key={name}
                      className="inline-flex items-center gap-1 rounded-md border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-800 px-2 py-1 text-sm"
                    >
                      {name}
                      <button
                        type="button"
                        onClick={() => removeOutput(name)}
                        className="text-gray-500 hover:text-gray-900 dark:hover:text-gray-200"
                        aria-label={`Remove ${name}`}
                      >
                        ×
                      </button>
                    </span>
                  ))}
                  {outputProperties.length < toPropNames.length && (
                    <Select
                      value=""
                      onValueChange={(v) => {
                        if (v && !outputProperties.includes(v)) setOutputProperties((prev) => [...prev, v]);
                      }}
                    >
                      <SelectTrigger className="w-[120px] h-8">
                        <SelectValue placeholder="Add output" />
                      </SelectTrigger>
                      <SelectContent>
                        {toPropNames
                          .filter((n) => !outputProperties.includes(n))
                          .map((n) => (
                            <SelectItem key={n} value={n}>
                              {n}
                            </SelectItem>
                          ))}
                      </SelectContent>
                    </Select>
                  )}
                </div>
              </div>
            </div>
            <div className="w-1/2 min-w-0 flex flex-col gap-2 overflow-hidden border border-gray-200 dark:border-gray-700 rounded-lg bg-gray-900">
              <div className="shrink-0 flex items-center gap-2 px-3 py-2 border-b border-gray-700">
                <Label className="text-xs font-medium text-gray-400">Rule type</Label>
                <Select value={ruleType} onValueChange={(v) => setRuleType(v as MigrationRuleType)}>
                  <SelectTrigger className="w-[160px] h-8 border-gray-600 bg-gray-800 text-gray-200">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {RULE_TYPE_OPTIONS.map((o) => (
                      <SelectItem key={o.value} value={o.value}>
                        {o.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="flex-1 min-h-0 overflow-hidden">
                <MonacoEditor
                  height="100%"
                  language="javascript"
                  theme="vs-dark"
                  value={ruleContent}
                  onChange={(value) => setRuleContent(value ?? '')}
                  options={{
                    readOnly: false,
                    minimap: { enabled: false },
                    scrollBeyondLastLine: false,
                    fontSize: CODE_EDITOR_FONT_SIZE,
                    wordWrap: 'on',
                    lineNumbers: 'on',
                  }}
                />
              </div>
            </div>
          </div>

          {/* Test section: 50/50 test inputs | output */}
          <div className="shrink-0 pt-3 border-t border-gray-200 dark:border-gray-700">
            <div className="flex items-center justify-between mb-2">
              <Label className="text-sm font-medium text-gray-700 dark:text-gray-300">Test rule</Label>
              <button
                type="button"
                onClick={handleRunTest}
                className={cn(
                  'inline-flex items-center gap-2 rounded-lg border px-3 py-1.5 text-sm',
                  'border-indigo-200 dark:border-indigo-800 bg-indigo-50 dark:bg-indigo-900/30',
                  'text-indigo-700 dark:text-indigo-300 hover:bg-indigo-100 dark:hover:bg-indigo-900/50'
                )}
              >
                <Play className="h-4 w-4" />
                Run
              </button>
            </div>
            <div className="flex gap-4 min-h-[120px]">
              <div className="w-1/2 min-w-0 flex flex-col gap-2 overflow-y-auto border border-gray-200 dark:border-gray-700 rounded-lg p-3 bg-gray-50/50 dark:bg-gray-800/30">
                <span className="text-xs font-medium text-gray-500 dark:text-gray-400">Test inputs</span>
                {inputProperties.length === 0 ? (
                  <p className="text-xs text-gray-400 dark:text-gray-500">Add inputs above.</p>
                ) : (
                  inputProperties.map((name) => (
                    <div key={name} className="flex items-center gap-2">
                      <Label className="w-24 shrink-0 text-xs text-gray-600 dark:text-gray-400">{name}</Label>
                      <Input
                        value={testInputValues[name] ?? ''}
                        onChange={(e) =>
                          setTestInputValues((prev) => ({ ...prev, [name]: e.target.value }))
                        }
                        placeholder="Sample value"
                        className="flex-1 font-mono text-sm h-8"
                      />
                    </div>
                  ))
                )}
              </div>
              <div className="w-1/2 min-w-0 flex flex-col border border-gray-200 dark:border-gray-700 rounded-lg p-3 bg-gray-50/50 dark:bg-gray-800/30 overflow-hidden">
                <span className="text-xs font-medium text-gray-500 dark:text-gray-400 shrink-0">Output</span>
                <div className="flex-1 min-h-0 overflow-auto mt-1">
                  {testResult === null ? (
                    <p className="text-xs text-gray-400 dark:text-gray-500">Click Run to see the result.</p>
                  ) : testResult.ok ? (
                    <ul className="font-mono text-sm text-emerald-700 dark:text-emerald-300 space-y-0.5">
                      {outputProperties.map((name, i) => (
                        <li key={name}>
                          {name}: {String(testResult.outputs[i] ?? '')}
                        </li>
                      ))}
                    </ul>
                  ) : (
                    <div className="flex items-start gap-2 text-sm text-red-700 dark:text-red-300">
                      <AlertCircle className="h-4 w-4 shrink-0 mt-0.5" />
                      <span>{testResult.error}</span>
                    </div>
                  )}
                </div>
              </div>
            </div>
          </div>
        </div>

        <DialogFooter className="shrink-0 flex-col gap-2 sm:flex-row sm:items-center px-6 pb-6 pt-2 border-t border-gray-200 dark:border-gray-700">
          {!isValid && (
            <span className="text-xs text-amber-600 dark:text-amber-400 sm:mr-auto">
              {!inputsMet && `Add at least ${minInputs} input(s). `}
              {!outputsMet && `Add at least ${minOutputs} output(s). `}
              {inputsMet && outputsMet && !ruleContent.trim() && 'Enter rule expression or script.'}
            </span>
          )}
          <div className="flex gap-2 w-full sm:w-auto sm:ml-auto">
            <button
              type="button"
              onClick={() => onOpenChange(false)}
              className="rounded-lg border border-gray-300 dark:border-gray-600 px-4 py-2 text-sm text-gray-700 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-800"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={handleSave}
              disabled={!isValid}
              className="rounded-lg bg-indigo-600 px-4 py-2 text-sm text-white hover:bg-indigo-700 disabled:opacity-50 disabled:pointer-events-none"
            >
              Save rule
            </button>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
