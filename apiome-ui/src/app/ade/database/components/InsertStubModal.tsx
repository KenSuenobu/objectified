'use client';

import * as React from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/app/components/ui/Tabs';
import { Input } from '@/app/components/ui/Input';
import { Label } from '@/app/components/ui/Label';
import { Textarea } from '@/app/components/ui/Textarea';
import { Checkbox } from '@/app/components/ui/Checkbox';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/app/components/ui/Select';
import { validatePayloadAgainstSchema } from '@lib/database/validateSchema';
import {
  getPropertyType,
  getEnumOptions,
  getPattern,
  isMoneyField,
  isUuidField,
  isTimestampField,
  getTimestampDefaultKind,
  getInitialFormData,
  getOrderedPropertyEntries,
  isNullable,
} from '@lib/database/insert-form-schema-utils';
import { generateUuid, generateTimestamp, type UuidVersion } from '@lib/database/generate-field-value';
import { Button } from '@/app/components/ui/Button';

interface InsertStubModalProps {
  open: boolean;
  onClose: () => void;
  tableName: string;
  classSchemaId: string;
  /** When set, modal is in edit mode: load snapshot and PATCH on save */
  recordId?: string | null;
  onInserted?: () => void;
  onUpdated?: () => void;
}

type SchemaProperty = Record<string, unknown>;

export default function InsertStubModal({
  open,
  onClose,
  tableName,
  classSchemaId,
  recordId,
  onInserted,
  onUpdated,
}: InsertStubModalProps) {
  const isEdit = Boolean(recordId);
  const [schema, setSchema] = React.useState<Record<string, unknown> | null>(null);
  const [schemaLoading, setSchemaLoading] = React.useState(false);
  const [schemaError, setSchemaError] = React.useState<string | null>(null);
  const [formData, setFormData] = React.useState<Record<string, unknown>>({});
  const [activeTab, setActiveTab] = React.useState<'form' | 'json'>('form');
  const [jsonText, setJsonText] = React.useState('{}');
  const [jsonParseError, setJsonParseError] = React.useState<string | null>(null);
  const [validationErrors, setValidationErrors] = React.useState<Array<{ path?: string; message: string }>>([]);
  const [submitError, setSubmitError] = React.useState<string | null>(null);
  const [submitting, setSubmitting] = React.useState(false);
  const [patternErrors, setPatternErrors] = React.useState<Record<string, string | null>>({});
  const [uuidVersions, setUuidVersions] = React.useState<Record<string, UuidVersion>>({});

  React.useEffect(() => {
    if (!open || !classSchemaId) {
      setSchema(null);
      setSchemaError(null);
      setFormData({});
      setActiveTab('form');
      setJsonText('{}');
      setJsonParseError(null);
      setValidationErrors([]);
      setSubmitError(null);
      setPatternErrors({});
      setUuidVersions({});
      return;
    }
    setSchemaLoading(true);
    setSchemaError(null);
    fetch(`/api/database/schema?classSchemaId=${encodeURIComponent(classSchemaId)}`)
      .then((r) => r.json())
      .then((data) => {
        if (data.success && data.schema) {
          const s = data.schema as Record<string, unknown>;
          setSchema(s);
          if (isEdit && recordId) {
            fetch(`/api/database/snapshot/${encodeURIComponent(recordId)}?classSchemaId=${encodeURIComponent(classSchemaId)}`)
              .then((r2) => r2.json())
              .then((snap) => {
                if (snap.success && snap.data != null) {
                  const initial = typeof snap.data === 'object' && snap.data !== null ? (snap.data as Record<string, unknown>) : {};
                  setFormData(initial);
                  setJsonText(JSON.stringify(initial, null, 2));
                } else {
                  setSchemaError(snap.error ?? 'Failed to load record');
                }
                setSchemaLoading(false);
              })
              .catch((err) => {
                setSchemaError(err?.message ?? 'Failed to load record');
                setSchemaLoading(false);
              });
            return;
          }
          const initial = getInitialFormData(s);
          setFormData(initial);
          setJsonText(JSON.stringify(initial, null, 2));
        } else {
          setSchemaError(data.error ?? 'Failed to load schema');
        }
      })
      .catch((err) => setSchemaError(err?.message ?? 'Failed to load schema'))
      .finally(() => {
        if (!isEdit || !recordId) setSchemaLoading(false);
      });
  }, [open, classSchemaId, isEdit, recordId]);

  // When switching to JSON tab, sync formData -> jsonText
  React.useEffect(() => {
    if (activeTab === 'json' && schema) {
      setJsonText(JSON.stringify(formData, null, 2));
      setJsonParseError(null);
    }
  }, [activeTab]); // eslint-disable-line react-hooks/exhaustive-deps -- only when tab changes to json

  // Re-run pattern validation when formData changes (e.g. after applying from JSON tab)
  React.useEffect(() => {
    if (!schema) return;
    const entries = getOrderedPropertyEntries(schema);
    const next: Record<string, string | null> = {};
    for (const [key, propSchema] of entries) {
      const pattern = getPattern(propSchema);
      if (!pattern) continue;
      const val = formData[key];
      const str = val === undefined || val === null ? '' : String(val);
      try {
        const re = new RegExp(pattern);
        next[key] = str !== '' && !re.test(str) ? 'Value does not match required pattern' : null;
      } catch {
        next[key] = null;
      }
    }
    setPatternErrors((prev) => {
      const same = Object.keys(next).every((k) => prev[k] === next[k]);
      return same ? prev : { ...prev, ...next };
    });
  }, [formData, schema]);

  const applyJsonToForm = () => {
    try {
      const parsed = JSON.parse(jsonText);
      if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
        setJsonParseError('Value must be a JSON object');
        return;
      }
      setFormData(parsed as Record<string, unknown>);
      setJsonText(JSON.stringify(parsed, null, 2));
      setJsonParseError(null);
    } catch {
      setJsonParseError('Invalid JSON');
    }
  };

  const updateField = (key: string, value: unknown) => {
    setFormData((prev) => ({ ...prev, [key]: value }));
  };

  const handleSubmit = () => {
    setValidationErrors([]);
    setSubmitError(null);
    setJsonParseError(null);
    if (!schema) return;

    let data: Record<string, unknown>;
    if (activeTab === 'json') {
      try {
        const parsed = JSON.parse(jsonText);
        if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
          setValidationErrors([{ message: 'Invalid JSON or not an object' }]);
          return;
        }
        data = parsed as Record<string, unknown>;
      } catch {
        setValidationErrors([{ message: 'Invalid JSON' }]);
        return;
      }
    } else {
      const propertyEntriesForSubmit = getOrderedPropertyEntries(schema);
      data = {};
      for (const [key, propSchema] of propertyEntriesForSubmit) {
        const type = getPropertyType(propSchema);
        let val = formData[key];
        if ((type === 'array' || type === 'object') && typeof val === 'string') {
          try {
            val = JSON.parse(val || (type === 'array' ? '[]' : '{}'));
          } catch {
            setValidationErrors([{ message: `Invalid JSON for field "${key}"` }]);
            return;
          }
        }
        data[key] = val;
      }
    }

    const result = validatePayloadAgainstSchema(data, schema);
    if (!result.valid) {
      setValidationErrors(result.errors ?? [{ message: 'Validation failed' }]);
      return;
    }

    setSubmitting(true);
    if (isEdit && recordId) {
      fetch(`/api/database/snapshot/${encodeURIComponent(recordId)}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ classSchemaId, data }),
      })
        .then((r) => r.json())
        .then((res) => {
          if (res.success) {
            onUpdated?.();
            onClose();
          } else {
            setSubmitError(res.error ?? 'Update failed');
            if (res.errors?.length) {
              setValidationErrors(
                res.errors.map((e: { path?: string; message?: string }) => ({
                  path: e.path,
                  message: e.message ?? 'Validation failed',
                }))
              );
            }
          }
        })
        .catch((err) => setSubmitError(err?.message ?? 'Request failed'))
        .finally(() => setSubmitting(false));
      return;
    }
    fetch('/api/database/snapshot/insert', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ classSchemaId, data }),
    })
      .then((r) => r.json())
      .then((res) => {
        if (res.success) {
          onInserted?.();
          onClose();
        } else {
          setSubmitError(res.error ?? 'Insert failed');
          if (res.errors?.length) {
            setValidationErrors(
              res.errors.map((e: { path?: string; message?: string }) => ({
                path: e.path,
                message: e.message ?? 'Validation failed',
              }))
            );
          }
        }
      })
      .catch((err) => setSubmitError(err?.message ?? 'Request failed'))
      .finally(() => setSubmitting(false));
  };

  const requiredSet = React.useMemo(() => {
    const r = schema?.required;
    if (!Array.isArray(r)) return new Set<string>();
    return new Set(r.map((x) => String(x)));
  }, [schema]);

  const propertyEntries = schema ? getOrderedPropertyEntries(schema) : [];

  return (
    <Dialog.Root open={open} onOpenChange={(o) => !o && onClose()}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 bg-black/50 z-50 data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0" />
        <Dialog.Content
          aria-describedby={undefined}
          className="fixed left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 z-50 w-full max-w-2xl h-[85vh] max-h-[720px] flex flex-col rounded-lg bg-white dark:bg-gray-800 shadow-lg border border-gray-200 dark:border-gray-700 data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0"
        >
          <Dialog.Title className="text-lg font-semibold text-gray-900 dark:text-white p-6 pb-2">
            {isEdit ? 'Edit record' : 'Insert record'}
          </Dialog.Title>
          <Dialog.Description className="px-6 text-sm text-gray-500 dark:text-gray-400">
            {isEdit
              ? `Edit the record in "${tableName}". Data is validated against the class schema before saving.`
              : `Insert a new record into "${tableName}". Data is validated against the class schema before saving.`}
          </Dialog.Description>

          <div className="flex-1 min-h-[320px] flex flex-col p-6 gap-4 overflow-hidden">
            {schemaLoading && (
              <p className="text-sm text-gray-500 dark:text-gray-400">Loading schema…</p>
            )}
            {schemaError && (
              <p className="text-sm text-red-600 dark:text-red-400">{schemaError}</p>
            )}
            {schema && !schemaLoading && (
              <>
                <Tabs value={activeTab} onValueChange={(v) => setActiveTab(v as 'form' | 'json')} className="flex-1 flex flex-col min-h-[280px]">
                  <TabsList className="w-full">
                    <TabsTrigger value="form">Form</TabsTrigger>
                    <TabsTrigger value="json">JSON</TabsTrigger>
                  </TabsList>
                  <TabsContent value="form" className="flex-1 min-h-0 overflow-auto mt-3 data-[state=inactive]:hidden">
                    <div className="space-y-4 pr-2">
                      {propertyEntries.length === 0 ? (
                        <p className="text-sm text-gray-500 dark:text-gray-400">No properties defined in schema.</p>
                      ) : (
                        propertyEntries.map(([key, propSchema]) => {
                          const type = getPropertyType(propSchema);
                          const required = requiredSet.has(key);
                          const nullable = isNullable(propSchema);
                          const requirementLabel = required
                            ? (nullable ? 'Required, Nullable' : 'Required')
                            : (nullable ? 'Optional, Nullable' : 'Optional');
                          const requirementPillClass =
                            'inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium bg-gray-100 dark:bg-gray-700 text-gray-600 dark:text-gray-400';
                          const label = (propSchema.title as string) || key;
                          const fieldSummary = (propSchema.summary as string) || (propSchema.description as string) || undefined;
                          const patternLabel = getPattern(propSchema);
                          const value = formData[key];

                          if (type === 'boolean') {
                            return (
                              <div key={key} className="flex items-center gap-3">
                                <Checkbox
                                  id={`field-${key}`}
                                  checked={value === true}
                                  onCheckedChange={(checked) => updateField(key, checked === true)}
                                />
                                <div className="flex flex-col gap-0.5">
                                  <div className="flex items-center gap-2 flex-wrap">
                                    <Label htmlFor={`field-${key}`} className="cursor-pointer">
                                      {label}
                                      {required && <span className="text-red-500 ml-0.5">*</span>}
                                    </Label>
                                    <span className={requirementPillClass}>{requirementLabel}</span>
                                  </div>
                                  {fieldSummary && (
                                    <span className="text-xs text-gray-500 dark:text-gray-400">{fieldSummary}</span>
                                  )}
                                </div>
                              </div>
                            );
                          }

                          if (type === 'number' || type === 'integer') {
                            const numVal = value === undefined || value === null || value === '' ? '' : Number(value);
                            const money = isMoneyField(propSchema, key);
                            return (
                              <div key={key} className="space-y-1.5">
                                <div className="flex items-center gap-2 flex-wrap">
                                  <Label htmlFor={`field-${key}`}>
                                    {label}
                                    {required && <span className="text-red-500 ml-0.5">*</span>}
                                  </Label>
                                  <span className={requirementPillClass}>{requirementLabel}</span>
                                </div>
                                {fieldSummary && (
                                  <p className="text-xs text-gray-500 dark:text-gray-400">{fieldSummary}</p>
                                )}
                                <Input
                                  id={`field-${key}`}
                                  type="number"
                                  step={money ? '0.01' : type === 'integer' ? '1' : 'any'}
                                  inputMode={money ? 'decimal' : 'numeric'}
                                  value={numVal === '' ? '' : numVal}
                                  onChange={(e) => {
                                    const v = e.target.value;
                                    updateField(key, v === '' ? undefined : (type === 'integer' ? parseInt(v, 10) : parseFloat(v)));
                                  }}
                                />
                              </div>
                            );
                          }

                          if (type === 'array' || type === 'object') {
                            const str = (() => {
                              try {
                                return typeof value === 'string' ? value : JSON.stringify(value ?? (type === 'array' ? [] : {}), null, 2);
                              } catch {
                                return '{}';
                              }
                            })();
                            return (
                              <div key={key} className="space-y-1.5">
                                <div className="flex items-center gap-2 flex-wrap">
                                  <Label htmlFor={`field-${key}`}>
                                    {label} ({type})
                                    {required && <span className="text-red-500 ml-0.5">*</span>}
                                  </Label>
                                  <span className={requirementPillClass}>{requirementLabel}</span>
                                </div>
                                {fieldSummary && (
                                  <p className="text-xs text-gray-500 dark:text-gray-400">{fieldSummary}</p>
                                )}
                                <Textarea
                                  id={`field-${key}`}
                                  value={str}
                                  onChange={(e) => setFormData((prev) => ({ ...prev, [key]: e.target.value }))}
                                  onBlur={(e) => {
                                    try {
                                      const parsed = JSON.parse(e.target.value || (type === 'array' ? '[]' : '{}'));
                                      updateField(key, parsed);
                                    } catch {
                                      // leave as string until valid
                                    }
                                  }}
                                  className="min-h-[80px] font-mono text-sm"
                                  placeholder={type === 'array' ? '[]' : '{}'}
                                  spellCheck={false}
                                />
                              </div>
                            );
                          }

                          return (
                            <div key={key} className="space-y-1.5">
                              <div className="flex items-center gap-2 flex-wrap">
                                <Label htmlFor={`field-${key}`}>
                                  {label}
                                  {patternLabel && (
                                    <span className="text-gray-500 dark:text-gray-400 font-normal">
                                      {' '}(regex: {patternLabel})
                                    </span>
                                  )}
                                  {required && <span className="text-red-500 ml-0.5">*</span>}
                                </Label>
                                <span className={requirementPillClass}>{requirementLabel}</span>
                              </div>
                              {fieldSummary && (
                                <p className="text-xs text-gray-500 dark:text-gray-400">{fieldSummary}</p>
                              )}
                              {(() => {
                                const enumOpts = getEnumOptions(propSchema);
                                const pattern = getPattern(propSchema);
                                const money = isMoneyField(propSchema, key);
                                const strVal = value === undefined || value === null ? '' : String(value);
                                const patternError = patternErrors[key] ?? null;

                                if (enumOpts.length > 0) {
                                  const EMPTY_ENUM_VALUE = '__none__';
                                  const selectValue = strVal === '' ? EMPTY_ENUM_VALUE : strVal;
                                  return (
                                    <Select
                                      value={selectValue}
                                      onValueChange={(v) => updateField(key, v === EMPTY_ENUM_VALUE ? '' : v)}
                                    >
                                      <SelectTrigger id={`field-${key}`}>
                                        <SelectValue placeholder="Select…" />
                                      </SelectTrigger>
                                      <SelectContent>
                                        {!required && (
                                          <SelectItem value={EMPTY_ENUM_VALUE}>(none)</SelectItem>
                                        )}
                                        {enumOpts.map((opt, i) => {
                                          const optStr = String(opt);
                                          return (
                                            <SelectItem key={i} value={optStr}>
                                              {optStr}
                                            </SelectItem>
                                          );
                                        })}
                                      </SelectContent>
                                    </Select>
                                  );
                                }

                                if (pattern) {
                                  const handlePatternChange = (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => {
                                    const v = e.target.value;
                                    updateField(key, v);
                                    try {
                                      const re = new RegExp(pattern);
                                      if (v !== '' && !re.test(v)) {
                                        setPatternErrors((prev) => ({ ...prev, [key]: 'Value does not match required pattern' }));
                                      } else {
                                        setPatternErrors((prev) => ({ ...prev, [key]: null }));
                                      }
                                    } catch {
                                      setPatternErrors((prev) => ({ ...prev, [key]: null }));
                                    }
                                  };
                                  return (
                                    <>
                                      <Input
                                        id={`field-${key}`}
                                        type="text"
                                        value={strVal}
                                        onChange={handlePatternChange}
                                        className={patternError ? 'border-red-500 dark:border-red-500' : ''}
                                      />
                                      {patternError && (
                                        <p className="text-xs text-red-600 dark:text-red-400">{patternError}</p>
                                      )}
                                    </>
                                  );
                                }

                                if (money) {
                                  const handleMoneyChange = (e: React.ChangeEvent<HTMLInputElement>) => {
                                    const v = e.target.value;
                                    if (v === '' || /^-?\d*\.?\d{0,2}$/.test(v)) {
                                      updateField(key, v === '' ? '' : v);
                                    }
                                  };
                                  return (
                                    <Input
                                      id={`field-${key}`}
                                      type="text"
                                      inputMode="decimal"
                                      value={strVal}
                                      onChange={handleMoneyChange}
                                      placeholder="0.00"
                                    />
                                  );
                                }

                                if (isUuidField(propSchema, key)) {
                                  const version = uuidVersions[key] ?? 4;
                                  return (
                                    <div className="flex gap-2 items-center flex-wrap">
                                      <Input
                                        id={`field-${key}`}
                                        type="text"
                                        value={strVal}
                                        onChange={(e) => updateField(key, e.target.value)}
                                        className="flex-1 min-w-[200px]"
                                        placeholder="e.g. 550e8400-e29b-41d4-a716-446655440000"
                                      />
                                      <Select
                                        value={String(version)}
                                        onValueChange={(v) =>
                                          setUuidVersions((prev) => ({ ...prev, [key]: Number(v) as UuidVersion }))
                                        }
                                      >
                                        <SelectTrigger className="w-[80px]">
                                          <SelectValue />
                                        </SelectTrigger>
                                        <SelectContent>
                                          <SelectItem value="1">v1</SelectItem>
                                          <SelectItem value="4">v4</SelectItem>
                                          <SelectItem value="7">v7</SelectItem>
                                        </SelectContent>
                                      </Select>
                                      <Button
                                        type="button"
                                        variant="outline"
                                        size="sm"
                                        onClick={() => updateField(key, generateUuid(version))}
                                      >
                                        Generate
                                      </Button>
                                    </div>
                                  );
                                }

                                if (isTimestampField(propSchema, key)) {
                                  const kind = getTimestampDefaultKind(propSchema);
                                  return (
                                    <div className="flex gap-2 items-center flex-wrap">
                                      <Input
                                        id={`field-${key}`}
                                        type="text"
                                        value={strVal}
                                        onChange={(e) => updateField(key, e.target.value)}
                                        className="flex-1 min-w-[200px]"
                                        placeholder="e.g. 2024-01-15T12:00:00.000Z"
                                      />
                                      <Button
                                        type="button"
                                        variant="outline"
                                        size="sm"
                                        onClick={() => updateField(key, generateTimestamp(kind))}
                                      >
                                        Generate
                                      </Button>
                                    </div>
                                  );
                                }

                                return (
                                  <Textarea
                                    id={`field-${key}`}
                                    value={strVal}
                                    onChange={(e) => updateField(key, e.target.value)}
                                    className="min-h-[80px] resize-y"
                                    rows={3}
                                  />
                                );
                              })()}
                            </div>
                          );
                        })
                      )}
                    </div>
                  </TabsContent>
                  <TabsContent value="json" className="flex-1 min-h-0 flex flex-col mt-3 data-[state=inactive]:hidden">
                    <p className="text-xs text-gray-500 dark:text-gray-400 mb-2">
                      Edit the JSON below. Apply to sync into the form view.
                    </p>
                    <Textarea
                      value={jsonText}
                      onChange={(e) => setJsonText(e.target.value)}
                      onBlur={applyJsonToForm}
                      className="flex-1 min-h-[200px] font-mono text-sm resize-none"
                      placeholder='{"key": "value"}'
                      spellCheck={false}
                    />
                    <button
                      type="button"
                      onClick={applyJsonToForm}
                      className="mt-2 self-start px-3 py-1.5 text-sm rounded-lg border border-gray-200 dark:border-gray-600 bg-white dark:bg-gray-800 text-gray-700 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-700"
                    >
                      Apply to form
                    </button>
                    {jsonParseError && (
                      <p className="mt-1 text-sm text-red-600 dark:text-red-400">{jsonParseError}</p>
                    )}
                  </TabsContent>
                </Tabs>
                {(validationErrors.length > 0 || submitError) && (
                  <div className="rounded-lg border border-red-200 dark:border-red-800 bg-red-50 dark:bg-red-900/20 p-3 text-sm text-red-700 dark:text-red-300">
                    {submitError && <p className="font-medium">{submitError}</p>}
                    {validationErrors.length > 0 && (
                      <ul className="mt-1 list-disc list-inside">
                        {validationErrors.map((e, i) => (
                          <li key={i}>
                            {e.path ? `${e.path}: ` : ''}{e.message}
                          </li>
                        ))}
                      </ul>
                    )}
                  </div>
                )}
              </>
            )}
          </div>

          <div className="flex justify-end gap-2 p-6 pt-2 border-t border-gray-200 dark:border-gray-700">
            <button
              type="button"
              onClick={onClose}
              className="px-4 py-2 rounded-lg border border-gray-200 dark:border-gray-600 bg-white dark:bg-gray-800 text-sm text-gray-700 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-700"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={handleSubmit}
              disabled={!schema || submitting || Object.values(patternErrors).some(Boolean)}
              className="px-4 py-2 rounded-lg bg-indigo-600 text-white text-sm font-medium hover:bg-indigo-700 disabled:opacity-50 disabled:pointer-events-none"
            >
              {submitting ? (isEdit ? 'Saving…' : 'Inserting…') : isEdit ? 'Save' : 'Insert'}
            </button>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
