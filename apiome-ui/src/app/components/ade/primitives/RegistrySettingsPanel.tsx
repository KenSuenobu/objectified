'use client';

/**
 * The registry Settings tab (#3472, restyled by HIVE-6.5, #5316).
 *
 * Authority: `docs/mockups/build/primitives.html` §Settings — the defaults banner, the storage
 * health pill, and the four sections (JSON Schema dialect · Reference resolution · Import
 * defaults · Validation & publishing) over a Reset / Save footer that stays disabled until the
 * form is dirty.
 *
 * ### What this replaces
 *
 * `PrimitivesSettingsView`, whose controls were a `selectClass` constant of
 * `border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-700` repeated on seven selects,
 * a `text-indigo-600` checkbox on ten toggles, and a health pill hand-painted
 * `bg-emerald-100 text-emerald-700` / `bg-red-100 text-red-700`.
 *
 * ### One control changed
 *
 * The ten booleans are **switches**, not checkboxes. That is what the mockup draws, and it is
 * the honest control: each one takes effect on Save as a *setting*, not as a value submitted
 * with a form. Their accessible names are unchanged, so the same assertions still find them —
 * under `role="switch"` rather than `role="checkbox"`. The Accepted-formats list stays
 * checkboxes, because there it really is a multi-select.
 */

import * as React from 'react';
import {
  AlertTriangle,
  CheckCircle2,
  Database,
  FileJson,
  GitFork,
  RotateCcw,
  Save,
  ShieldCheck,
  Upload,
} from 'lucide-react';

import { Alert } from '@/app/components/ui/Alert';
import { Badge } from '@/app/components/ui/Badge';
import { Button } from '@/app/components/ui/Button';
import { Card } from '@/app/components/ui/Card';
import { Checkbox } from '@/app/components/ui/Checkbox';
import { Input } from '@/app/components/ui/Input';
import { Label } from '@/app/components/ui/Label';
import { LoadingState } from '@/app/components/ui/LoadingState';
import { Switch } from '@/app/components/ui/Switch';
import { Textarea } from '@/app/components/ui/Textarea';
import {
  ACCEPTED_FORMAT_OPTIONS,
  CIRCULAR_POLICY_OPTIONS,
  CORE_PUBLISH_ROLE_OPTIONS,
  DEFAULT_SETTINGS,
  DRAFT_OPTIONS,
  IMPORT_SCOPE_OPTIONS,
  MAX_RESOLUTION_DEPTH,
  MIN_RESOLUTION_DEPTH,
  REF_STYLE_OPTIONS,
  clampDepth,
  coerceSettings,
  diffSettings,
  formatAllowlist,
  hasChanges,
  parseAllowlist,
  toggleInList,
  type CircularRefPolicy,
  type CorePublishRole,
  type DefaultDraft,
  type ImportScope,
  type RefStyle,
  type RegistryHealth,
  type TypeRegistrySettings,
  type TypeRegistrySettingsResponse,
} from '@/app/ade/dashboard/primitives/primitivesSettingsModel';

import { SETTINGS_DEFAULTS_NOTE, registryStorageBadge } from './primitivesModel';

/** A switch with its title and one-line explanation, as `hive.css` §9 `.switch-row` draws it. */
function SwitchRow({
  id,
  label,
  description,
  checked,
  onChange,
}: {
  id: string;
  label: string;
  description: string;
  checked: boolean;
  onChange: (value: boolean) => void;
}) {
  return (
    <div className="prm-switch-row">
      <span className="prm-switch-row__text">
        <span className="prm-switch-row__title">{label}</span>
        <span className="prm-switch-row__desc">{description}</span>
      </span>
      <Switch
        id={id}
        checked={checked}
        onCheckedChange={onChange}
        // A Radix switch is a `<button>`, which no `<label for>` can name; the label is the
        // control's own so it survives however the row is laid out.
        aria-label={label}
      />
    </div>
  );
}

/** A titled settings card wrapping a group of related controls. */
function SettingsSection({
  icon,
  title,
  children,
}: {
  icon: React.ReactNode;
  title: string;
  children: React.ReactNode;
}) {
  return (
    <Card className="prm-settings-card">
      <h3 className="prm-gov-card__title">
        {icon}
        {title}
      </h3>
      <div className="prm-settings-card__body">{children}</div>
    </Card>
  );
}

export interface RegistrySettingsPanelProps {
  /** Surface success / error notices through the screen's toaster. */
  onMessage?: (type: 'success' | 'error', text: string) => void;
}

/**
 * Render the tab. See {@link RegistrySettingsPanelProps}.
 *
 * @returns The banner, the four sections and the footer actions.
 */
export default function RegistrySettingsPanel({ onMessage }: RegistrySettingsPanelProps) {
  // `baseline` is the last-saved state; `form` is the in-progress edit. Save diffs the two.
  const [baseline, setBaseline] = React.useState<TypeRegistrySettings>(DEFAULT_SETTINGS);
  const [form, setForm] = React.useState<TypeRegistrySettings>(DEFAULT_SETTINGS);
  const [usingDefaults, setUsingDefaults] = React.useState(true);
  const [health, setHealth] = React.useState<RegistryHealth | null>(null);
  const [loading, setLoading] = React.useState(true);
  const [saving, setSaving] = React.useState(false);
  // The allowlist textarea is edited as free text and parsed into the form on change.
  const [allowlistText, setAllowlistText] = React.useState(
    formatAllowlist(DEFAULT_SETTINGS.remote_host_allowlist)
  );

  const applyLoaded = React.useCallback((settings: TypeRegistrySettings) => {
    setBaseline(settings);
    setForm(settings);
    setAllowlistText(formatAllowlist(settings.remote_host_allowlist));
  }, []);

  const load = React.useCallback(async () => {
    setLoading(true);
    try {
      const [settingsRes, healthRes] = await Promise.all([
        fetch('/api/types/settings'),
        fetch('/api/primitives/health'),
      ]);
      const [settingsData, healthData] = await Promise.all([settingsRes.json(), healthRes.json()]);

      if (settingsData.success && settingsData.settings) {
        const payload = settingsData.settings as TypeRegistrySettingsResponse;
        setUsingDefaults(Boolean(payload.is_default));
        applyLoaded(coerceSettings(payload));
      } else {
        onMessage?.('error', settingsData.error || 'Failed to load settings');
      }

      if (healthData.success && healthData.health) {
        setHealth(healthData.health as RegistryHealth);
      } else {
        setHealth(null);
      }
    } catch (error) {
      console.error('Error loading registry settings:', error);
      onMessage?.('error', 'Failed to load settings');
    } finally {
      setLoading(false);
    }
  }, [applyLoaded, onMessage]);

  React.useEffect(() => {
    void load();
  }, [load]);

  const dirty = React.useMemo(() => hasChanges(baseline, form), [baseline, form]);

  /** Patch one field of the in-progress form. */
  const setField = React.useCallback(
    <K extends keyof TypeRegistrySettings>(key: K, value: TypeRegistrySettings[K]) => {
      setForm((current) => ({ ...current, [key]: value }));
    },
    []
  );

  const handleAllowlistChange = React.useCallback((text: string) => {
    setAllowlistText(text);
    setForm((current) => ({ ...current, remote_host_allowlist: parseAllowlist(text) }));
  }, []);

  const handleReset = React.useCallback(() => {
    setForm(DEFAULT_SETTINGS);
    setAllowlistText(formatAllowlist(DEFAULT_SETTINGS.remote_host_allowlist));
  }, []);

  const handleSave = React.useCallback(async () => {
    const payload = diffSettings(baseline, form);
    if (Object.keys(payload).length === 0) {
      onMessage?.('error', 'No changes to save');
      return;
    }

    setSaving(true);
    try {
      const res = await fetch('/api/types/settings', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      const data = await res.json();
      if (data.success && data.settings) {
        const saved = data.settings as TypeRegistrySettingsResponse;
        setUsingDefaults(Boolean(saved.is_default));
        applyLoaded(coerceSettings(saved));
        onMessage?.('success', 'Registry settings saved');
      } else {
        onMessage?.('error', data.error || 'Failed to save settings');
      }
    } catch (error) {
      console.error('Error saving registry settings:', error);
      onMessage?.('error', 'Failed to save settings');
    } finally {
      setSaving(false);
    }
  }, [applyLoaded, baseline, form, onMessage]);

  if (loading) {
    return <LoadingState minHeightClassName="min-h-[20rem]" message="Loading settings…" />;
  }

  const storage = registryStorageBadge(health);

  return (
    <div className="prm-settings">
      {usingDefaults && (
        <Alert variant="info" data-testid="primitives-settings-defaults">
          <span>{SETTINGS_DEFAULTS_NOTE}</span>
        </Alert>
      )}

      {/* Registry storage status — live from the registry health probe (#3450). */}
      <Card className="prm-settings-card">
        <div className="prm-settings-card__head">
          <h3 className="prm-gov-card__title">
            <Database aria-hidden />
            Registry storage
          </h3>
          {storage ? (
            <Badge variant={storage.tone} dot data-testid="primitives-storage-badge">
              {storage.tone === 'ok' ? <CheckCircle2 aria-hidden /> : <AlertTriangle aria-hidden />}
              {storage.label}
            </Badge>
          ) : (
            <span className="prm-quiet">status unknown</span>
          )}
        </div>
        <p className="prm-settings-card__desc">
          The registry is stored in the shared <span className="mono">apiome-db</span> (
          <span className="mono">apiome.primitives</span>) — there is no separate registry
          database. Storage table present:{' '}
          <span className="mono">{health?.storage_present ? 'yes' : 'no'}</span>.
        </p>
        {health?.error && (
          <p className="prm-settings-card__error mono" role="status">
            {health.error}
          </p>
        )}
      </Card>

      <SettingsSection icon={<FileJson aria-hidden />} title="JSON Schema dialect">
        <div className="prm-field">
          <Label htmlFor="default-draft">Default draft</Label>
          <select
            id="default-draft"
            value={form.default_draft}
            onChange={(e) => setField('default_draft', e.target.value as DefaultDraft)}
            className="hive-control prm-select"
          >
            {DRAFT_OPTIONS.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
        </div>
        <SwitchRow
          id="strict-validation"
          label="Strict validation"
          description="Reject unknown formats."
          checked={form.strict_validation}
          onChange={(value) => setField('strict_validation', value)}
        />
        <SwitchRow
          id="allow-annotations"
          label="Allow annotation keywords"
          description="Permit title, description, examples, etc."
          checked={form.allow_annotation_keywords}
          onChange={(value) => setField('allow_annotation_keywords', value)}
        />
        <SwitchRow
          id="coerce-drafts"
          label="Coerce imported drafts to default"
          description="Upgrade older drafts to the default dialect on import."
          checked={form.coerce_imported_drafts}
          onChange={(value) => setField('coerce_imported_drafts', value)}
        />
      </SettingsSection>

      <SettingsSection icon={<GitFork aria-hidden />} title="Reference resolution">
        <div className="prm-grid-2">
          <div className="prm-field">
            <Label htmlFor="resolution-base">Resolution base URL</Label>
            <Input
              id="resolution-base"
              type="text"
              className="mono"
              value={form.resolution_base_url}
              onChange={(e) => setField('resolution_base_url', e.target.value)}
            />
            <p className="prm-hint">Relative $ref resolve against this base.</p>
          </div>
          <div className="prm-field">
            <Label htmlFor="ref-style">$ref style</Label>
            <select
              id="ref-style"
              value={form.ref_style}
              onChange={(e) => setField('ref_style', e.target.value as RefStyle)}
              className="hive-control prm-select"
            >
              {REF_STYLE_OPTIONS.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
          </div>
        </div>
        <SwitchRow
          id="allow-remote-refs"
          label="Allow remote $ref"
          description="Fetch schemas from external hosts during resolution."
          checked={form.allow_remote_refs}
          onChange={(value) => setField('allow_remote_refs', value)}
        />
        <div className="prm-grid-2">
          <div className="prm-field">
            <Label htmlFor="remote-allowlist">Remote host allowlist</Label>
            <Textarea
              id="remote-allowlist"
              className="mono"
              value={allowlistText}
              onChange={(e) => handleAllowlistChange(e.target.value)}
              disabled={!form.allow_remote_refs}
              rows={3}
              placeholder="json-schema.org&#10;spec.openapis.org"
            />
            <p className="prm-hint">One host per line. Only used when remote $ref is allowed.</p>
          </div>
          <div className="prm-stack">
            <div className="prm-field">
              <Label htmlFor="max-depth">Max resolution depth</Label>
              <Input
                id="max-depth"
                type="number"
                min={MIN_RESOLUTION_DEPTH}
                max={MAX_RESOLUTION_DEPTH}
                value={form.max_resolution_depth}
                onChange={(e) => setField('max_resolution_depth', clampDepth(Number(e.target.value)))}
              />
            </div>
            <div className="prm-field">
              <Label htmlFor="circular-policy">Circular ref policy</Label>
              <select
                id="circular-policy"
                value={form.circular_ref_policy}
                onChange={(e) =>
                  setField('circular_ref_policy', e.target.value as CircularRefPolicy)
                }
                className="hive-control prm-select"
              >
                {CIRCULAR_POLICY_OPTIONS.map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.label}
                  </option>
                ))}
              </select>
            </div>
          </div>
        </div>
      </SettingsSection>

      <SettingsSection icon={<Upload aria-hidden />} title="Import defaults">
        <div className="prm-grid-2">
          <div className="prm-field">
            <Label htmlFor="import-scope">Default scope</Label>
            <select
              id="import-scope"
              value={form.default_import_scope}
              onChange={(e) => setField('default_import_scope', e.target.value as ImportScope)}
              className="hive-control prm-select"
            >
              {IMPORT_SCOPE_OPTIONS.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
          </div>
          <div className="prm-field">
            <Label htmlFor="default-namespace">Default target namespace</Label>
            <Input
              id="default-namespace"
              type="text"
              className="mono"
              value={form.default_target_namespace ?? ''}
              placeholder="(none)"
              onChange={(e) =>
                setField('default_target_namespace', e.target.value.trim() ? e.target.value : null)
              }
            />
          </div>
        </div>
        <SwitchRow
          id="rewrite-refs"
          label="Rewrite refs to relative on import"
          description="Convert absolute $ref to base-relative paths."
          checked={form.rewrite_refs_on_import}
          onChange={(value) => setField('rewrite_refs_on_import', value)}
        />
        <fieldset className="prm-formats">
          <legend className="prm-field__legend">Accepted formats</legend>
          {ACCEPTED_FORMAT_OPTIONS.map((option) => {
            const id = `format-${option.value}`;
            return (
              <span key={option.value} className="prm-check">
                <Checkbox
                  id={id}
                  checked={form.accepted_formats.includes(option.value)}
                  onCheckedChange={() =>
                    setField('accepted_formats', toggleInList(form.accepted_formats, option.value))
                  }
                />
                <Label htmlFor={id}>{option.label}</Label>
              </span>
            );
          })}
        </fieldset>
        <SwitchRow
          id="dedupe-types"
          label="Dedupe identical types"
          description="Reuse an existing type when an import matches it byte-for-byte."
          checked={form.dedupe_identical_types}
          onChange={(value) => setField('dedupe_identical_types', value)}
        />
      </SettingsSection>

      <SettingsSection icon={<ShieldCheck aria-hidden />} title="Validation & publishing">
        <SwitchRow
          id="validate-on-save"
          label="Validate on save"
          description="Run dialect & $ref checks before persisting."
          checked={form.validate_on_save}
          onChange={(value) => setField('validate_on_save', value)}
        />
        <SwitchRow
          id="block-publish"
          label="Block publish on validation errors"
          description="Prevent publishing types with unresolved $ref or schema errors."
          checked={form.block_publish_on_errors}
          onChange={(value) => setField('block_publish_on_errors', value)}
        />
        <div className="prm-field">
          <Label htmlFor="core-publish-role">Who can publish core (std/*) types</Label>
          <select
            id="core-publish-role"
            value={form.core_publish_role}
            onChange={(e) => setField('core_publish_role', e.target.value as CorePublishRole)}
            className="hive-control prm-select"
          >
            {CORE_PUBLISH_ROLE_OPTIONS.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
          <p className="prm-hint">
            Core system types are shared with all tenants; publishing is governed.
          </p>
        </div>
      </SettingsSection>

      <Card className="prm-settings-actions">
        <Button variant="outline" onClick={handleReset} disabled={saving}>
          <RotateCcw aria-hidden />
          Reset to defaults
        </Button>
        <Button onClick={() => void handleSave()} disabled={saving || !dirty}>
          <Save aria-hidden />
          {saving ? 'Saving…' : 'Save settings'}
        </Button>
      </Card>
    </div>
  );
}
