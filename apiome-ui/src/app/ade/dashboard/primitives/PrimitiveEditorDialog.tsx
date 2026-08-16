'use client';

import { useState, useEffect, useMemo } from 'react';
import { AlertCircle, CheckCircle, Code, Settings, X, Plus } from 'lucide-react';
import { Button } from '@/app/components/ui/Button';
import { Input } from '@/app/components/ui/Input';
import { Label } from '@/app/components/ui/Label';
import { Textarea } from '@/app/components/ui/Textarea';
import { Alert } from '@/app/components/ui/Alert';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/app/components/ui/Dialog';
import { Checkbox } from '@/app/components/ui/Checkbox';
import { TAB_LIST_CLASS, tabTriggerClass } from '@/app/components/ui/tabStyles';
import { cn } from '@lib/utils';
import dynamic from 'next/dynamic';
import Ajv from 'ajv';
import addFormats from 'ajv-formats';
import { CODE_EDITOR_FONT_SIZE } from '@/app/components/ui/code/editorTypography';

const MonacoEditor = dynamic(() => import('@monaco-editor/react'), { ssr: false });

interface Primitive {
  id: string;
  name: string;
  description: string | null;
  category: string;
  schema: Record<string, unknown>;
  tags: string[];
  is_system: boolean;
}

interface Props {
  primitive: Primitive | null;
  onClose: () => void;
  onSave: () => void;
  onMessage: (type: 'success' | 'error', message: string) => void;
}

interface PrimitiveFormData {
  // Basic
  name: string;
  description: string;
  category: string;
  tags: string;

  // String constraints
  format: string;
  pattern: string;
  minLength: string;
  maxLength: string;

  // Number constraints
  minimum: string;
  maximum: string;
  exclusiveMinimum: boolean;
  exclusiveMaximum: boolean;
  multipleOf: string;

  // Array constraints
  minItems: string;
  maxItems: string;
  uniqueItems: boolean;
  arrayItemType: string;

  // Object constraints
  minProperties: string;
  maxProperties: string;
  additionalProperties: boolean;

  // Common
  enum: string[];
  defaultValue: string;
  nullable: boolean;

  // Examples
  examples: string[];
}

const CATEGORIES = ['string', 'number', 'integer', 'boolean', 'array', 'object'];

const STRING_FORMATS = [
  { value: '', label: 'None' },
  { value: 'email', label: 'Email' },
  { value: 'uri', label: 'URI' },
  { value: 'uuid', label: 'UUID' },
  { value: 'date', label: 'Date (YYYY-MM-DD)' },
  { value: 'date-time', label: 'Date-Time (ISO 8601)' },
  { value: 'time', label: 'Time (HH:MM:SS)' },
  { value: 'duration', label: 'Duration (ISO 8601)' },
  { value: 'hostname', label: 'Hostname' },
  { value: 'ipv4', label: 'IPv4 Address' },
  { value: 'ipv6', label: 'IPv6 Address' },
  { value: 'regex', label: 'Regular Expression' },
  { value: 'json-pointer', label: 'JSON Pointer' },
  { value: 'password', label: 'Password (masked)' },
  { value: 'byte', label: 'Base64 Encoded' },
  { value: 'binary', label: 'Binary Data' },
];

const ARRAY_ITEM_TYPES = [
  { value: 'string', label: 'String' },
  { value: 'number', label: 'Number' },
  { value: 'integer', label: 'Integer' },
  { value: 'boolean', label: 'Boolean' },
  { value: 'object', label: 'Object' },
];

const initialFormData: PrimitiveFormData = {
  name: '',
  description: '',
  category: 'string',
  tags: '',
  format: '',
  pattern: '',
  minLength: '',
  maxLength: '',
  minimum: '',
  maximum: '',
  exclusiveMinimum: false,
  exclusiveMaximum: false,
  multipleOf: '',
  minItems: '',
  maxItems: '',
  uniqueItems: false,
  arrayItemType: 'string',
  minProperties: '',
  maxProperties: '',
  additionalProperties: true,
  enum: [],
  defaultValue: '',
  nullable: false,
  examples: [],
};

export default function PrimitiveEditorDialog({ primitive, onClose, onSave, onMessage }: Props) {
  const [formData, setFormData] = useState<PrimitiveFormData>(initialFormData);
  const [activeTab, setActiveTab] = useState<'form' | 'advanced'>('form');
  const [advancedJson, setAdvancedJson] = useState('');
  const [saving, setSaving] = useState(false);
  const [validationError, setValidationError] = useState<string | null>(null);
  const [schemaError, setSchemaError] = useState<string | null>(null);
  const [enumInput, setEnumInput] = useState('');
  const [exampleInput, setExampleInput] = useState('');

  // Initialize form from primitive
  useEffect(() => {
    if (primitive) {
      const schema = primitive.schema;
      setFormData({
        name: primitive.name,
        description: primitive.description || '',
        category: primitive.category,
        tags: primitive.tags.join(', '),
        format: (schema.format as string) || '',
        pattern: (schema.pattern as string) || '',
        minLength: schema.minLength !== undefined ? String(schema.minLength) : '',
        maxLength: schema.maxLength !== undefined ? String(schema.maxLength) : '',
        minimum: schema.minimum !== undefined ? String(schema.minimum) : (schema.exclusiveMinimum !== undefined ? String(schema.exclusiveMinimum) : ''),
        maximum: schema.maximum !== undefined ? String(schema.maximum) : (schema.exclusiveMaximum !== undefined ? String(schema.exclusiveMaximum) : ''),
        exclusiveMinimum: schema.exclusiveMinimum !== undefined,
        exclusiveMaximum: schema.exclusiveMaximum !== undefined,
        multipleOf: schema.multipleOf !== undefined ? String(schema.multipleOf) : '',
        minItems: schema.minItems !== undefined ? String(schema.minItems) : '',
        maxItems: schema.maxItems !== undefined ? String(schema.maxItems) : '',
        uniqueItems: Boolean(schema.uniqueItems),
        arrayItemType: ((schema.items as Record<string, unknown>)?.type as string) || 'string',
        minProperties: schema.minProperties !== undefined ? String(schema.minProperties) : '',
        maxProperties: schema.maxProperties !== undefined ? String(schema.maxProperties) : '',
        additionalProperties: schema.additionalProperties !== false,
        enum: Array.isArray(schema.enum) ? schema.enum.map(String) : [],
        defaultValue: schema.default !== undefined ? JSON.stringify(schema.default) : '',
        nullable: Array.isArray(schema.type) && (schema.type as string[]).includes('null'),
        examples: Array.isArray(schema.examples) ? schema.examples.map((e: unknown) => JSON.stringify(e)) : [],
      });
      setAdvancedJson(JSON.stringify(primitive.schema, null, 2));
    } else {
      setFormData(initialFormData);
      setAdvancedJson(JSON.stringify({ type: 'string' }, null, 2));
    }
  }, [primitive]);

  // Build schema from form data
  const buildSchema = useMemo(() => {
    const schema: Record<string, unknown> = {
      type: formData.nullable ? [formData.category, 'null'] : formData.category,
    };

    // Description in schema
    if (formData.description) {
      schema.description = formData.description;
    }

    // String constraints
    if (formData.category === 'string') {
      if (formData.format) schema.format = formData.format;
      if (formData.pattern) schema.pattern = formData.pattern;
      if (formData.minLength) schema.minLength = parseInt(formData.minLength, 10);
      if (formData.maxLength) schema.maxLength = parseInt(formData.maxLength, 10);
    }

    // Number/Integer constraints
    if (formData.category === 'number' || formData.category === 'integer') {
      if (formData.minimum) {
        if (formData.exclusiveMinimum) {
          schema.exclusiveMinimum = parseFloat(formData.minimum);
        } else {
          schema.minimum = parseFloat(formData.minimum);
        }
      }
      if (formData.maximum) {
        if (formData.exclusiveMaximum) {
          schema.exclusiveMaximum = parseFloat(formData.maximum);
        } else {
          schema.maximum = parseFloat(formData.maximum);
        }
      }
      if (formData.multipleOf) schema.multipleOf = parseFloat(formData.multipleOf);
    }

    // Array constraints
    if (formData.category === 'array') {
      schema.items = { type: formData.arrayItemType };
      if (formData.minItems) schema.minItems = parseInt(formData.minItems, 10);
      if (formData.maxItems) schema.maxItems = parseInt(formData.maxItems, 10);
      if (formData.uniqueItems) schema.uniqueItems = true;
    }

    // Object constraints
    if (formData.category === 'object') {
      schema.properties = {};
      if (formData.minProperties) schema.minProperties = parseInt(formData.minProperties, 10);
      if (formData.maxProperties) schema.maxProperties = parseInt(formData.maxProperties, 10);
      if (!formData.additionalProperties) schema.additionalProperties = false;
    }

    // Common constraints
    if (formData.enum.length > 0) {
      schema.enum = formData.category === 'integer'
        ? formData.enum.map(v => parseInt(v, 10))
        : formData.category === 'number'
        ? formData.enum.map(v => parseFloat(v))
        : formData.enum;
    }

    if (formData.defaultValue) {
      try {
        schema.default = JSON.parse(formData.defaultValue);
      } catch {
        // Use as string if not valid JSON
        schema.default = formData.defaultValue;
      }
    }

    if (formData.examples.length > 0) {
      schema.examples = formData.examples.map(e => {
        try {
          return JSON.parse(e);
        } catch {
          return e;
        }
      });
    }

    return schema;
  }, [formData]);

  // Update advanced JSON when form changes
  useEffect(() => {
    if (activeTab === 'form') {
      setAdvancedJson(JSON.stringify(buildSchema, null, 2));
    }
  }, [buildSchema, activeTab]);

  const updateField = <K extends keyof PrimitiveFormData>(field: K, value: PrimitiveFormData[K]) => {
    setFormData(prev => ({ ...prev, [field]: value }));
  };

  const addEnumValue = () => {
    if (enumInput.trim() && !formData.enum.includes(enumInput.trim())) {
      updateField('enum', [...formData.enum, enumInput.trim()]);
      setEnumInput('');
    }
  };

  const removeEnumValue = (value: string) => {
    updateField('enum', formData.enum.filter(v => v !== value));
  };

  const addExample = () => {
    if (exampleInput.trim() && !formData.examples.includes(exampleInput.trim())) {
      updateField('examples', [...formData.examples, exampleInput.trim()]);
      setExampleInput('');
    }
  };

  const removeExample = (value: string) => {
    updateField('examples', formData.examples.filter(v => v !== value));
  };

  const validateSchema = (jsonString: string): boolean => {
    try {
      const parsed = JSON.parse(jsonString);
      if (typeof parsed !== 'object' || parsed === null) {
        setSchemaError('Schema must be a valid JSON object');
        return false;
      }
      const ajv = new Ajv({ strictSchema: false } as object);
      (addFormats as (ajv: unknown) => void)(ajv);
      try {
        ajv.compile(parsed);
        setSchemaError(null);
        return true;
      } catch (err) {
        const error = err as Error;
        setSchemaError(`Invalid JSON Schema: ${error.message}`);
        return false;
      }
    } catch (err) {
      const error = err as Error;
      setSchemaError(`Invalid JSON: ${error.message}`);
      return false;
    }
  };

  const handleAdvancedJsonChange = (value: string | undefined) => {
    const newValue = value || '';
    setAdvancedJson(newValue);
    if (newValue.trim()) {
      validateSchema(newValue);
    } else {
      setSchemaError(null);
    }
  };

  const handleSave = async () => {
    setValidationError(null);

    if (!formData.name.trim()) {
      setValidationError('Name is required');
      return;
    }

    let finalSchema: Record<string, unknown>;

    if (activeTab === 'advanced') {
      if (!validateSchema(advancedJson)) {
        setValidationError('Please fix schema errors before saving');
        return;
      }
      try {
        finalSchema = JSON.parse(advancedJson);
      } catch {
        setValidationError('Invalid JSON schema');
        return;
      }
    } else {
      finalSchema = buildSchema;
    }

    const tags = formData.tags.split(',').map(t => t.trim()).filter(t => t.length > 0);
    setSaving(true);

    try {
      const url = primitive ? `/api/primitives/${primitive.id}` : '/api/primitives';
      const method = primitive ? 'PUT' : 'POST';
      const body = {
        name: formData.name.trim(),
        description: formData.description.trim() || null,
        category: formData.category,
        schema: finalSchema,
        tags,
      };

      const response = await fetch(url, {
        method,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });

      const data = await response.json();
      if (data.success) {
        onMessage('success', `Primitive ${primitive ? 'updated' : 'created'} successfully`);
        onSave();
      } else {
        onMessage('error', data.error || `Failed to ${primitive ? 'update' : 'create'} primitive`);
      }
    } catch (error) {
      console.error('Error saving primitive:', error);
      onMessage('error', `Failed to ${primitive ? 'update' : 'create'} primitive`);
    } finally {
      setSaving(false);
    }
  };

  const renderStringFields = () => (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-4">
        <div className="space-y-2">
          <Label htmlFor="format">Format</Label>
          <select
            id="format"
            value={formData.format}
            onChange={(e) => updateField('format', e.target.value)}
            disabled={saving}
            className="w-full px-3 py-2 border border-gray-300 dark:border-gray-600 rounded-lg bg-white dark:bg-gray-700 text-gray-900 dark:text-white"
          >
            {STRING_FORMATS.map(f => (
              <option key={f.value} value={f.value}>{f.label}</option>
            ))}
          </select>
        </div>
        <div className="space-y-2">
          <Label htmlFor="pattern">Pattern (Regex)</Label>
          <Input
            id="pattern"
            value={formData.pattern}
            onChange={(e) => updateField('pattern', e.target.value)}
            placeholder="^[a-zA-Z0-9]+$"
            disabled={saving}
          />
        </div>
      </div>
      <div className="grid grid-cols-2 gap-4">
        <div className="space-y-2">
          <Label htmlFor="minLength">Min Length</Label>
          <Input
            id="minLength"
            type="number"
            min="0"
            value={formData.minLength}
            onChange={(e) => updateField('minLength', e.target.value)}
            disabled={saving}
          />
        </div>
        <div className="space-y-2">
          <Label htmlFor="maxLength">Max Length</Label>
          <Input
            id="maxLength"
            type="number"
            min="0"
            value={formData.maxLength}
            onChange={(e) => updateField('maxLength', e.target.value)}
            disabled={saving}
          />
        </div>
      </div>
    </div>
  );

  const renderNumberFields = () => (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-4">
        <div className="space-y-2">
          <Label htmlFor="minimum">Minimum</Label>
          <div className="flex items-center gap-2">
            <Input
              id="minimum"
              type="number"
              value={formData.minimum}
              onChange={(e) => updateField('minimum', e.target.value)}
              disabled={saving}
              className="flex-1"
            />
            <label className="flex items-center gap-1 text-sm text-gray-600 dark:text-gray-400 whitespace-nowrap">
              <Checkbox
                checked={formData.exclusiveMinimum}
                onCheckedChange={(checked) => updateField('exclusiveMinimum', !!checked)}
              />
              Exclusive
            </label>
          </div>
        </div>
        <div className="space-y-2">
          <Label htmlFor="maximum">Maximum</Label>
          <div className="flex items-center gap-2">
            <Input
              id="maximum"
              type="number"
              value={formData.maximum}
              onChange={(e) => updateField('maximum', e.target.value)}
              disabled={saving}
              className="flex-1"
            />
            <label className="flex items-center gap-1 text-sm text-gray-600 dark:text-gray-400 whitespace-nowrap">
              <Checkbox
                checked={formData.exclusiveMaximum}
                onCheckedChange={(checked) => updateField('exclusiveMaximum', !!checked)}
              />
              Exclusive
            </label>
          </div>
        </div>
      </div>
      <div className="space-y-2">
        <Label htmlFor="multipleOf">Multiple Of</Label>
        <Input
          id="multipleOf"
          type="number"
          step="any"
          value={formData.multipleOf}
          onChange={(e) => updateField('multipleOf', e.target.value)}
          placeholder="e.g., 0.01 for currency"
          disabled={saving}
        />
      </div>
    </div>
  );

  const renderArrayFields = () => (
    <div className="space-y-4">
      <div className="space-y-2">
        <Label htmlFor="arrayItemType">Item Type</Label>
        <select
          id="arrayItemType"
          value={formData.arrayItemType}
          onChange={(e) => updateField('arrayItemType', e.target.value)}
          disabled={saving}
          className="w-full px-3 py-2 border border-gray-300 dark:border-gray-600 rounded-lg bg-white dark:bg-gray-700 text-gray-900 dark:text-white"
        >
          {ARRAY_ITEM_TYPES.map(t => (
            <option key={t.value} value={t.value}>{t.label}</option>
          ))}
        </select>
      </div>
      <div className="grid grid-cols-2 gap-4">
        <div className="space-y-2">
          <Label htmlFor="minItems">Min Items</Label>
          <Input
            id="minItems"
            type="number"
            min="0"
            value={formData.minItems}
            onChange={(e) => updateField('minItems', e.target.value)}
            disabled={saving}
          />
        </div>
        <div className="space-y-2">
          <Label htmlFor="maxItems">Max Items</Label>
          <Input
            id="maxItems"
            type="number"
            min="0"
            value={formData.maxItems}
            onChange={(e) => updateField('maxItems', e.target.value)}
            disabled={saving}
          />
        </div>
      </div>
      <label className="flex items-center gap-2">
        <Checkbox
          checked={formData.uniqueItems}
          onCheckedChange={(checked) => updateField('uniqueItems', !!checked)}
        />
        <span className="text-sm text-gray-700 dark:text-gray-300">Unique Items Only</span>
      </label>
    </div>
  );

  const renderObjectFields = () => (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-4">
        <div className="space-y-2">
          <Label htmlFor="minProperties">Min Properties</Label>
          <Input
            id="minProperties"
            type="number"
            min="0"
            value={formData.minProperties}
            onChange={(e) => updateField('minProperties', e.target.value)}
            disabled={saving}
          />
        </div>
        <div className="space-y-2">
          <Label htmlFor="maxProperties">Max Properties</Label>
          <Input
            id="maxProperties"
            type="number"
            min="0"
            value={formData.maxProperties}
            onChange={(e) => updateField('maxProperties', e.target.value)}
            disabled={saving}
          />
        </div>
      </div>
      <label className="flex items-center gap-2">
        <Checkbox
          checked={formData.additionalProperties}
          onCheckedChange={(checked) => updateField('additionalProperties', !!checked)}
        />
        <span className="text-sm text-gray-700 dark:text-gray-300">Allow Additional Properties</span>
      </label>
    </div>
  );

  const renderEnumSection = () => (
    <div className="space-y-2">
      <Label>Allowed Values (Enum)</Label>
      <div className="flex gap-2">
        <Input
          value={enumInput}
          onChange={(e) => setEnumInput(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && (e.preventDefault(), addEnumValue())}
          placeholder="Add a value..."
          disabled={saving}
          className="flex-1"
        />
        <Button type="button" variant="secondary" onClick={addEnumValue} disabled={saving}>
          <Plus className="w-4 h-4" />
        </Button>
      </div>
      {formData.enum.length > 0 && (
        <div className="flex flex-wrap gap-2 mt-2">
          {formData.enum.map((value) => (
            <span
              key={value}
              className="inline-flex items-center gap-1 px-2 py-1 bg-indigo-100 dark:bg-indigo-900/30 text-indigo-700 dark:text-indigo-300 rounded text-sm"
            >
              {value}
              <button type="button" onClick={() => removeEnumValue(value)} className="hover:text-red-500">
                <X className="w-3 h-3" />
              </button>
            </span>
          ))}
        </div>
      )}
    </div>
  );

  const renderExamplesSection = () => (
    <div className="space-y-2">
      <Label>Examples</Label>
      <div className="flex gap-2">
        <Input
          value={exampleInput}
          onChange={(e) => setExampleInput(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && (e.preventDefault(), addExample())}
          placeholder="Add an example value..."
          disabled={saving}
          className="flex-1"
        />
        <Button type="button" variant="secondary" onClick={addExample} disabled={saving}>
          <Plus className="w-4 h-4" />
        </Button>
      </div>
      {formData.examples.length > 0 && (
        <div className="flex flex-wrap gap-2 mt-2">
          {formData.examples.map((value, idx) => (
            <span
              key={idx}
              className="inline-flex items-center gap-1 px-2 py-1 bg-gray-100 dark:bg-gray-700 text-gray-700 dark:text-gray-300 rounded text-sm"
            >
              {value}
              <button type="button" onClick={() => removeExample(value)} className="hover:text-red-500">
                <X className="w-3 h-3" />
              </button>
            </span>
          ))}
        </div>
      )}
    </div>
  );

  return (
    <Dialog open onOpenChange={onClose}>
      <DialogContent className="max-w-4xl h-[90vh] min-h-[90vh] flex flex-col overflow-hidden" aria-describedby={undefined}>
        <DialogHeader>
          <DialogTitle>{primitive ? 'Edit Primitive' : 'Create Primitive'}</DialogTitle>
        </DialogHeader>

        {/* Tab Navigation */}
        <div role="tablist" aria-label="Primitive editor views" className={cn(TAB_LIST_CLASS, 'shrink-0')}>
          <button
            type="button"
            role="tab"
            aria-selected={activeTab === 'form'}
            onClick={() => setActiveTab('form')}
            className={tabTriggerClass({ active: activeTab === 'form' })}
          >
            <Settings className="w-4 h-4" />
            Form
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={activeTab === 'advanced'}
            onClick={() => setActiveTab('advanced')}
            className={tabTriggerClass({ active: activeTab === 'advanced' })}
          >
            <Code className="w-4 h-4" />
            Advanced JSON
          </button>
        </div>

        <div className="space-y-4 py-4 pr-[10px] flex-1 min-h-0 overflow-y-auto">
          {validationError && (
            <Alert variant="error">
              <AlertCircle className="h-4 w-4" />
              <span>{validationError}</span>
            </Alert>
          )}

          {activeTab === 'form' ? (
            <div className="space-y-6">
              {/* Basic Info */}
              <div className="space-y-4">
                <h3 className="text-sm font-semibold text-gray-900 dark:text-white">Basic Information</h3>
                <div className="grid grid-cols-2 gap-4">
                  <div className="space-y-2">
                    <Label htmlFor="name">Name *</Label>
                    <Input
                      id="name"
                      value={formData.name}
                      onChange={(e) => updateField('name', e.target.value)}
                      placeholder="e.g., Email Address, UUID"
                      disabled={saving}
                    />
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="category">Type *</Label>
                    <select
                      id="category"
                      value={formData.category}
                      onChange={(e) => updateField('category', e.target.value)}
                      disabled={saving || !!primitive}
                      className="w-full px-3 py-2 border border-gray-300 dark:border-gray-600 rounded-lg bg-white dark:bg-gray-700 text-gray-900 dark:text-white disabled:opacity-50"
                    >
                      {CATEGORIES.map(cat => (
                        <option key={cat} value={cat}>{cat}</option>
                      ))}
                    </select>
                  </div>
                </div>
                <div className="space-y-2">
                  <Label htmlFor="description">Description</Label>
                  <Textarea
                    id="description"
                    value={formData.description}
                    onChange={(e) => updateField('description', e.target.value)}
                    placeholder="Describe the purpose of this primitive"
                    rows={2}
                    disabled={saving}
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="tags">Tags</Label>
                  <Input
                    id="tags"
                    value={formData.tags}
                    onChange={(e) => updateField('tags', e.target.value)}
                    placeholder="email, contact, validation (comma-separated)"
                    disabled={saving}
                  />
                </div>
                <label className="flex items-center gap-2">
                  <Checkbox
                    checked={formData.nullable}
                    onCheckedChange={(checked) => updateField('nullable', !!checked)}
                  />
                  <span className="text-sm text-gray-700 dark:text-gray-300">Nullable (allows null value)</span>
                </label>
              </div>

              {/* Type-specific Constraints */}
              <div className="space-y-4">
                <h3 className="text-sm font-semibold text-gray-900 dark:text-white">
                  {formData.category.charAt(0).toUpperCase() + formData.category.slice(1)} Constraints
                </h3>
                {formData.category === 'string' && renderStringFields()}
                {(formData.category === 'number' || formData.category === 'integer') && renderNumberFields()}
                {formData.category === 'array' && renderArrayFields()}
                {formData.category === 'object' && renderObjectFields()}
                {formData.category === 'boolean' && (
                  <p className="text-sm text-gray-500 dark:text-gray-400">
                    Boolean type has no additional constraints. Use enum if you want to restrict to specific values.
                  </p>
                )}
              </div>

              {/* Enum Values */}
              <div className="space-y-4">
                <h3 className="text-sm font-semibold text-gray-900 dark:text-white">Validation</h3>
                {renderEnumSection()}
              </div>

              {/* Default & Examples */}
              <div className="space-y-4">
                <h3 className="text-sm font-semibold text-gray-900 dark:text-white">Default & Examples</h3>
                <div className="space-y-2">
                  <Label htmlFor="defaultValue">Default Value</Label>
                  <Input
                    id="defaultValue"
                    value={formData.defaultValue}
                    onChange={(e) => updateField('defaultValue', e.target.value)}
                    placeholder={formData.category === 'string' ? '"example"' : formData.category === 'boolean' ? 'true' : '0'}
                    disabled={saving}
                  />
                  <p className="text-xs text-gray-500">For strings use quotes, for objects/arrays use JSON</p>
                </div>
                {renderExamplesSection()}
              </div>

              {/* Schema Preview */}
              <div className="space-y-2">
                <div className="flex items-center justify-between">
                  <h3 className="text-sm font-semibold text-gray-900 dark:text-white">Schema Preview</h3>
                  <span className="text-xs text-green-600 flex items-center gap-1">
                    <CheckCircle className="w-3 h-3" /> Valid
                  </span>
                </div>
                <pre className="p-3 bg-gray-100 dark:bg-gray-800 rounded-lg text-xs overflow-auto max-h-40 font-mono">
                  {JSON.stringify(buildSchema, null, 2)}
                </pre>
              </div>
            </div>
          ) : (
            <div className="space-y-4">
              <div className="space-y-2">
                <div className="flex items-center justify-between">
                  <Label>JSON Schema</Label>
                  {schemaError ? (
                    <span className="text-xs text-red-600 flex items-center gap-1">
                      <AlertCircle className="w-3 h-3" /> Invalid
                    </span>
                  ) : advancedJson.trim() ? (
                    <span className="text-xs text-green-600 flex items-center gap-1">
                      <CheckCircle className="w-3 h-3" /> Valid
                    </span>
                  ) : null}
                </div>
                <div className="border border-gray-300 dark:border-gray-600 rounded-lg overflow-hidden min-h-[60vh]">
                  <MonacoEditor
                    height="60vh"
                    language="json"
                    theme="vs-dark"
                    value={advancedJson}
                    onChange={handleAdvancedJsonChange}
                    options={{
                      minimap: { enabled: false },
                      scrollBeyondLastLine: false,
                      fontSize: CODE_EDITOR_FONT_SIZE,
                      readOnly: saving,
                    }}
                  />
                </div>
                {schemaError && <p className="text-xs text-red-600">{schemaError}</p>}
              </div>
              <Alert variant="default">
                <span>Changes in Advanced mode will override the form. Switch to Form tab to use the visual editor.</span>
              </Alert>
            </div>
          )}
        </div>

        <DialogFooter>
          <Button variant="secondary" onClick={onClose} disabled={saving}>Cancel</Button>
          <Button onClick={handleSave} disabled={saving || (activeTab === 'advanced' && !!schemaError)}>
            {saving ? 'Saving...' : (primitive ? 'Update' : 'Create')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
