'use client';

/**
 * The create / edit primitive dialog (restyled by HIVE-6.5, #5316).
 *
 * Authority: `docs/mockups/build/primitives.html` §Overlays → *Create / edit primitive* — the
 * Form / Advanced JSON tabs, Basic information, the per-type constraint block, the enum chip
 * input, default & examples, and the live schema preview with its validity badge.
 *
 * ### What changed
 *
 * Only the skin. The Ajv compile, the form ⇄ schema round trip and the save path are untouched,
 * which is the ticket's fourth acceptance criterion: the editor validates exactly the same
 * JSON-Schema constraints as before. What went is the palette — six `<select>`s carrying
 * `border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-700`, `bg-indigo-100` enum chips,
 * `bg-gray-100 dark:bg-gray-800` example chips, a `bg-gray-100 dark:bg-gray-800` preview block,
 * and `text-green-600` / `text-red-600` validity text that is a {@link Badge} now.
 *
 * The two chip fields were separately hand-written and had drifted (different placeholders,
 * different remove buttons); they are one `renderChipField` call each now.
 */

import { useState, useEffect, useMemo } from 'react';
import { AlertCircle, CheckCircle, Code, Plus, Settings2, Shapes, X } from 'lucide-react';
import { Alert } from '@/app/components/ui/Alert';
import { Badge } from '@/app/components/ui/Badge';
import { Button } from '@/app/components/ui/Button';
import { Checkbox } from '@/app/components/ui/Checkbox';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/app/components/ui/Dialog';
import { Input } from '@/app/components/ui/Input';
import { Label } from '@/app/components/ui/Label';
import { Textarea } from '@/app/components/ui/Textarea';
import { TAB_LIST_CLASS, tabTriggerClass } from '@/app/components/ui/tabStyles';
import { CODE_EDITOR_FONT_SIZE } from '@/app/components/ui/code/editorTypography';
import { useHiveMonacoTheme } from '@/app/components/ui/code/monacoHiveTheme';
import { cn } from '@lib/utils';
import dynamic from 'next/dynamic';
import Ajv from 'ajv';
import addFormats from 'ajv-formats';

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
  // The raw-JSON tab is painted in the reader's own theme rather than Monaco's `vs-dark`, which
  // was a black box on a paper page in six of the nine appearances.
  const monacoTheme = useHiveMonacoTheme();
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


  /** The `string` constraint block — format, pattern and the two length bounds. */
  const renderStringFields = () => (
    <div className="prm-grid-4">
      <div className="prm-field">
        <Label htmlFor="format">Format</Label>
        <select
          id="format"
          value={formData.format}
          onChange={(e) => updateField('format', e.target.value)}
          disabled={saving}
          className="hive-control prm-select"
        >
          {STRING_FORMATS.map((f) => (
            <option key={f.value} value={f.value}>
              {f.label}
            </option>
          ))}
        </select>
      </div>
      <div className="prm-field">
        <Label htmlFor="pattern">Pattern (Regex)</Label>
        <Input
          id="pattern"
          className="mono"
          value={formData.pattern}
          onChange={(e) => updateField('pattern', e.target.value)}
          placeholder="^[a-zA-Z0-9]+$"
          disabled={saving}
        />
      </div>
      <div className="prm-field">
        <Label htmlFor="minLength">Min length</Label>
        <Input
          id="minLength"
          type="number"
          min="0"
          value={formData.minLength}
          onChange={(e) => updateField('minLength', e.target.value)}
          disabled={saving}
        />
      </div>
      <div className="prm-field">
        <Label htmlFor="maxLength">Max length</Label>
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
  );

  /** The `number` / `integer` block — the two bounds with their exclusivity, and multiple-of. */
  const renderNumberFields = () => (
    <>
      <div className="prm-grid-2">
        <div className="prm-field">
          <Label htmlFor="minimum">Minimum</Label>
          <div className="prm-bound">
            <Input
              id="minimum"
              type="number"
              value={formData.minimum}
              onChange={(e) => updateField('minimum', e.target.value)}
              disabled={saving}
            />
            <span className="prm-check">
              <Checkbox
                id="exclusive-minimum"
                checked={formData.exclusiveMinimum}
                onCheckedChange={(checked) => updateField('exclusiveMinimum', !!checked)}
              />
              <Label htmlFor="exclusive-minimum">Exclusive</Label>
            </span>
          </div>
        </div>
        <div className="prm-field">
          <Label htmlFor="maximum">Maximum</Label>
          <div className="prm-bound">
            <Input
              id="maximum"
              type="number"
              value={formData.maximum}
              onChange={(e) => updateField('maximum', e.target.value)}
              disabled={saving}
            />
            <span className="prm-check">
              <Checkbox
                id="exclusive-maximum"
                checked={formData.exclusiveMaximum}
                onCheckedChange={(checked) => updateField('exclusiveMaximum', !!checked)}
              />
              <Label htmlFor="exclusive-maximum">Exclusive</Label>
            </span>
          </div>
        </div>
      </div>
      <div className="prm-field">
        <Label htmlFor="multipleOf">Multiple of</Label>
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
    </>
  );

  /** The `array` block — the item type and the two count bounds. */
  const renderArrayFields = () => (
    <>
      <div className="prm-grid-2">
        <div className="prm-field">
          <Label htmlFor="arrayItemType">Item type</Label>
          <select
            id="arrayItemType"
            value={formData.arrayItemType}
            onChange={(e) => updateField('arrayItemType', e.target.value)}
            disabled={saving}
            className="hive-control prm-select"
          >
            {ARRAY_ITEM_TYPES.map((t) => (
              <option key={t.value} value={t.value}>
                {t.label}
              </option>
            ))}
          </select>
        </div>
        <div className="prm-field">
          <Label htmlFor="minItems">Min items</Label>
          <Input
            id="minItems"
            type="number"
            min="0"
            value={formData.minItems}
            onChange={(e) => updateField('minItems', e.target.value)}
            disabled={saving}
          />
        </div>
        <div className="prm-field">
          <Label htmlFor="maxItems">Max items</Label>
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
      <span className="prm-check">
        <Checkbox
          id="unique-items"
          checked={formData.uniqueItems}
          onCheckedChange={(checked) => updateField('uniqueItems', !!checked)}
        />
        <Label htmlFor="unique-items">Unique items only</Label>
      </span>
    </>
  );

  /** The `object` block — the property-count bounds and the additional-properties gate. */
  const renderObjectFields = () => (
    <>
      <div className="prm-grid-2">
        <div className="prm-field">
          <Label htmlFor="minProperties">Min properties</Label>
          <Input
            id="minProperties"
            type="number"
            min="0"
            value={formData.minProperties}
            onChange={(e) => updateField('minProperties', e.target.value)}
            disabled={saving}
          />
        </div>
        <div className="prm-field">
          <Label htmlFor="maxProperties">Max properties</Label>
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
      <span className="prm-check">
        <Checkbox
          id="additional-properties"
          checked={formData.additionalProperties}
          onCheckedChange={(checked) => updateField('additionalProperties', !!checked)}
        />
        <Label htmlFor="additional-properties">Allow additional properties</Label>
      </span>
    </>
  );

  /**
   * A chip list with an add-field beneath it — the enum values and the examples.
   *
   * One component for both because they are the same control: the mockup draws each as a row of
   * removable chips followed by an input, and having written it twice is how the two drifted into
   * different placeholder wording and different remove affordances.
   */
  const renderChipField = ({
    id,
    label,
    values,
    inputValue,
    onInputChange,
    onAdd,
    onRemove,
    placeholder,
    mono,
  }: {
    id: string;
    label: string;
    values: string[];
    inputValue: string;
    onInputChange: (value: string) => void;
    onAdd: () => void;
    onRemove: (value: string) => void;
    placeholder: string;
    mono?: boolean;
  }) => (
    <div className="prm-field">
      <Label htmlFor={id}>{label}</Label>
      <div className="prm-chips">
        {values.map((value) => (
          <span key={value} className={cn('prm-chip', mono && 'mono')}>
            {value}
            <button
              type="button"
              className="prm-chip__remove"
              onClick={() => onRemove(value)}
              aria-label={`Remove ${value}`}
            >
              <X aria-hidden />
            </button>
          </span>
        ))}
        <Input
          id={id}
          className="prm-chips__input"
          value={inputValue}
          onChange={(e) => onInputChange(e.target.value)}
          onKeyDown={(e) => {
            if (e.key !== 'Enter') return;
            e.preventDefault();
            onAdd();
          }}
          placeholder={placeholder}
          disabled={saving}
        />
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={onAdd}
          disabled={saving}
          aria-label={`Add to ${label.toLowerCase()}`}
        >
          <Plus aria-hidden />
        </Button>
      </div>
    </div>
  );

  return (
    <Dialog open onOpenChange={onClose}>
      <DialogContent size="xl" className="prm-dialog prm-dialog--tall" aria-describedby={undefined}>
        <DialogHeader className="prm-dialog__head">
          <span className="tnt-icon-tile" data-tone="accent" aria-hidden>
            <Shapes />
          </span>
          <div className="prm-dialog__heading">
            <DialogTitle>{primitive ? 'Edit primitive' : 'Create primitive'}</DialogTitle>
            <DialogDescription>
              Author a JSON Schema 2020-12 type via form or raw JSON.
            </DialogDescription>
          </div>
        </DialogHeader>

        <div
          role="tablist"
          aria-label="Primitive editor views"
          className={cn(TAB_LIST_CLASS, 'prm-dialog__tabs')}
        >
          <button
            type="button"
            role="tab"
            aria-selected={activeTab === 'form'}
            onClick={() => setActiveTab('form')}
            className={tabTriggerClass({ active: activeTab === 'form' })}
          >
            <Settings2 aria-hidden />
            Form
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={activeTab === 'advanced'}
            onClick={() => setActiveTab('advanced')}
            className={tabTriggerClass({ active: activeTab === 'advanced' })}
          >
            <Code aria-hidden />
            Advanced JSON
          </button>
        </div>

        <div className="prm-dialog__body prm-dialog__body--scroll">
          {validationError && (
            <Alert variant="danger">
              <span>{validationError}</span>
            </Alert>
          )}

          {activeTab === 'form' ? (
            <>
              <section className="prm-form-section">
                <h3 className="prm-form-section__title">Basic information</h3>
                <div className="prm-grid-2">
                  <div className="prm-field">
                    <Label htmlFor="name">
                      Name <span className="prm-req">*</span>
                    </Label>
                    <Input
                      id="name"
                      value={formData.name}
                      onChange={(e) => updateField('name', e.target.value)}
                      placeholder="e.g., Email Address, UUID"
                      disabled={saving}
                    />
                  </div>
                  <div className="prm-field">
                    <Label htmlFor="category">
                      Type <span className="prm-req">*</span>
                    </Label>
                    <select
                      id="category"
                      value={formData.category}
                      onChange={(e) => updateField('category', e.target.value)}
                      disabled={saving || !!primitive}
                      className="hive-control prm-select"
                    >
                      {CATEGORIES.map((cat) => (
                        <option key={cat} value={cat}>
                          {cat}
                        </option>
                      ))}
                    </select>
                    {primitive ? (
                      <p className="prm-hint">A type’s kind cannot change after it is created.</p>
                    ) : null}
                  </div>
                </div>
                <div className="prm-field">
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
                <div className="prm-grid-2">
                  <div className="prm-field">
                    <Label htmlFor="tags">Tags</Label>
                    <Input
                      id="tags"
                      value={formData.tags}
                      onChange={(e) => updateField('tags', e.target.value)}
                      placeholder="email, contact, validation (comma-separated)"
                      disabled={saving}
                    />
                  </div>
                  <span className="prm-check prm-check--field">
                    <Checkbox
                      id="nullable"
                      checked={formData.nullable}
                      onCheckedChange={(checked) => updateField('nullable', !!checked)}
                    />
                    <Label htmlFor="nullable">Nullable (allows null value)</Label>
                  </span>
                </div>
              </section>

              <section className="prm-form-section">
                <h3 className="prm-form-section__title">
                  {formData.category.charAt(0).toUpperCase() + formData.category.slice(1)}{' '}
                  constraints
                </h3>
                {formData.category === 'string' && renderStringFields()}
                {(formData.category === 'number' || formData.category === 'integer') &&
                  renderNumberFields()}
                {formData.category === 'array' && renderArrayFields()}
                {formData.category === 'object' && renderObjectFields()}
                {formData.category === 'boolean' && (
                  <p className="prm-quiet">
                    Boolean type has no additional constraints. Use enum if you want to restrict to
                    specific values.
                  </p>
                )}
              </section>

              <section className="prm-form-section">
                <h3 className="prm-form-section__title">Validation</h3>
                {renderChipField({
                  id: 'enum-value',
                  label: 'Allowed values (enum)',
                  values: formData.enum,
                  inputValue: enumInput,
                  onInputChange: setEnumInput,
                  onAdd: addEnumValue,
                  onRemove: removeEnumValue,
                  placeholder: 'Add a value...',
                })}
              </section>

              <section className="prm-form-section">
                <h3 className="prm-form-section__title">Default &amp; examples</h3>
                <div className="prm-grid-2">
                  <div className="prm-field">
                    <Label htmlFor="defaultValue">Default value</Label>
                    <Input
                      id="defaultValue"
                      className="mono"
                      value={formData.defaultValue}
                      onChange={(e) => updateField('defaultValue', e.target.value)}
                      placeholder={
                        formData.category === 'string'
                          ? '"example"'
                          : formData.category === 'boolean'
                            ? 'true'
                            : '0'
                      }
                      disabled={saving}
                    />
                    <p className="prm-hint">
                      For strings use quotes, for objects/arrays use JSON
                    </p>
                  </div>
                  {renderChipField({
                    id: 'example-value',
                    label: 'Examples',
                    values: formData.examples,
                    inputValue: exampleInput,
                    onInputChange: setExampleInput,
                    onAdd: addExample,
                    onRemove: removeExample,
                    placeholder: 'Add an example value...',
                    mono: true,
                  })}
                </div>
              </section>

              <section className="prm-form-section">
                <h3 className="prm-form-section__title">
                  Schema preview
                  <Badge variant="ok">
                    <CheckCircle aria-hidden />
                    Valid
                  </Badge>
                </h3>
                <pre className="prm-code prm-code--tall" data-testid="primitive-schema-preview">
                  {JSON.stringify(buildSchema, null, 2)}
                </pre>
              </section>
            </>
          ) : (
            <>
              <Alert variant="warn">
                <span>
                  Changes in Advanced mode will override the form. Switch to the Form tab to use the
                  visual editor.
                </span>
              </Alert>

              <div className="prm-editor__bar">
                <Label htmlFor="advanced-json">JSON Schema</Label>
                {schemaError ? (
                  <Badge variant="danger">
                    <AlertCircle aria-hidden />
                    Invalid
                  </Badge>
                ) : advancedJson.trim() ? (
                  <Badge variant="ok">
                    <CheckCircle aria-hidden />
                    Valid
                  </Badge>
                ) : null}
              </div>

              <div className="prm-editor" id="advanced-json">
                <MonacoEditor
                  height="52vh"
                  language="json"
                  theme={monacoTheme.theme}
                  beforeMount={monacoTheme.beforeMount}
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
              {schemaError && (
                <p className="prm-error" role="status">
                  {schemaError}
                </p>
              )}
            </>
          )}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={saving}>
            Cancel
          </Button>
          <Button
            onClick={() => void handleSave()}
            disabled={saving || (activeTab === 'advanced' && !!schemaError)}
          >
            {saving ? 'Saving…' : primitive ? 'Update' : 'Create'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
