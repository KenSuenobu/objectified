'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { Download, FileSignature, History, ShieldCheck, Upload } from 'lucide-react';

import { Alert } from '@/app/components/ui/Alert';
import { Badge } from '@/app/components/ui/Badge';
import { Button } from '@/app/components/ui/Button';
import { Card, CardContent, CardFooter, CardHeader } from '@/app/components/ui/Card';
import { Input } from '@/app/components/ui/Input';
import { Label } from '@/app/components/ui/Label';
import { Skeleton } from '@/app/components/ui/Skeleton';
import { Spinner } from '@/app/components/ui/Spinner';
import { Switch } from '@/app/components/ui/Switch';
import { formatPolicyInstant } from '@/app/components/ade/styleGuides';

import {
  DEFAULT_QUALITY_THRESHOLDS,
  QUALITY_GRADE_OPTIONS,
  QUALITY_SEVERITY_OPTIONS,
  isBlockingConfiguration,
  qualityPolicyApi,
  type QualityPolicy,
  type QualityPolicyVersionList,
  type QualityThresholds,
  type QualityWaiver,
  type QualityWaiverList,
} from './quality-policy-api';

/**
 * Governance → Import & export quality policy — IXH-2.3 (#5098), re-skinned by HIVE-5.6 (#5309).
 *
 * Authority: `docs/mockups/govern/style-guides.html`, its second tab; DESIGN.md §7 (fields)
 * and §12 (cards).
 *
 * The tenant-level gate that decides what may enter the catalog and what may leave it. It
 * lives beside the style guides because the two answer the same question at different
 * moments: a guide decides *how* a document is scored, this policy decides *what score is
 * good enough*.
 *
 * Each scope (import / export) carries three independent floors — minimum grade, minimum
 * score, and a severity that must not appear — plus an enforcement mode: `advisory` reports a
 * shortfall without stopping anyone, `block` refuses the operation. Below that sits the
 * override contract: whether a blocked user may proceed by recording a waiver, which roles
 * may, and how long a waiver lives.
 *
 * Saving appends an immutable version (the REST layer rejects a non-admin), so the version
 * list under the form is the change history each verdict names. The active waiver ledger is
 * shown beside it, because a policy without visibility of what has been waived is not
 * governance.
 *
 * ### What HIVE-5.6 changed
 *
 * Only the skin and two states. The fields, their copy, the save gate and every call are the
 * screen's own; what changed is that the form is a `Card` on tokens rather than eleven
 * `border-slate-200` boxes with four inline hue palettes, that the wait is a shaped skeleton
 * rather than a bare spinner, and that a read-only viewer is told the panel is read-only
 * instead of silently losing the Save button.
 */

/** The editable policy body — everything a PUT can change. */
interface PolicyDraft {
  importPolicy: QualityThresholds;
  exportPolicy: QualityThresholds;
  allowOverride: boolean;
  overrideRoles: string;
  waiverTtlHours: number;
}

/** Role slugs a tenant can name as permitted to waive (the built-in RBAC roles). */
const ROLE_OPTIONS = ['owner', 'admin', 'editor', 'viewer'] as const;

/** Normalize the API policy into editable draft state. */
function toDraft(policy: QualityPolicy): PolicyDraft {
  return {
    importPolicy: { ...DEFAULT_QUALITY_THRESHOLDS, ...policy.import },
    exportPolicy: { ...DEFAULT_QUALITY_THRESHOLDS, ...policy.export },
    allowOverride: policy.allowOverride,
    overrideRoles: (policy.overrideRoles ?? []).join(', '),
    waiverTtlHours: policy.waiverTtlHours,
  };
}

/** Parse the comma-separated role field into the slug list the API stores. */
export function parseRoleList(value: string): string[] {
  return value
    .split(',')
    .map((role) => role.trim().toLowerCase())
    .filter((role) => role.length > 0);
}

/** Detect unsaved edits against the loaded baseline. */
function isDraftDirty(draft: PolicyDraft, baseline: PolicyDraft): boolean {
  return JSON.stringify(draft) !== JSON.stringify(baseline);
}

/** One scope's editor: the three floors plus the enforcement mode. */
function ScopeFields({
  scope,
  thresholds,
  disabled,
  onChange,
}: {
  scope: 'import' | 'export';
  thresholds: QualityThresholds;
  disabled: boolean;
  onChange: (next: QualityThresholds) => void;
}) {
  const blocking = isBlockingConfiguration(thresholds);
  const Glyph = scope === 'import' ? Download : Upload;
  return (
    <fieldset className="qp-fieldset">
      <legend className="qp-legend">
        <Glyph aria-hidden className="qp-legend__glyph" />
        {scope === 'import' ? 'Import intake' : 'Export delivery'}
        <Badge
          variant={blocking ? 'rose' : 'neutral'}
          data-testid={`quality-policy-${scope}-mode`}
        >
          {blocking ? 'Blocking' : 'Advisory'}
        </Badge>
      </legend>

      <div className="qp-grid">
        <div className="sg-field">
          <Label htmlFor={`${scope}-min-grade`}>Minimum grade</Label>
          <select
            id={`${scope}-min-grade`}
            aria-label={`${scope} minimum grade`}
            className="hive-control sg-select"
            value={thresholds.minGrade ?? ''}
            disabled={disabled}
            onChange={(e) => onChange({ ...thresholds, minGrade: e.target.value || null })}
          >
            <option value="">No floor</option>
            {QUALITY_GRADE_OPTIONS.map((grade) => (
              <option key={grade} value={grade}>
                {grade}
              </option>
            ))}
          </select>
        </div>

        <div className="sg-field">
          <Label htmlFor={`${scope}-min-score`}>Minimum score</Label>
          <Input
            id={`${scope}-min-score`}
            aria-label={`${scope} minimum score`}
            type="number"
            min={0}
            max={100}
            className="sg-num"
            value={thresholds.minScore ?? ''}
            disabled={disabled}
            onChange={(e) =>
              onChange({
                ...thresholds,
                minScore: e.target.value === '' ? null : Number(e.target.value),
              })
            }
          />
        </div>
      </div>

      <div className="sg-field">
        <Label htmlFor={`${scope}-block-severity`}>Refuse findings at</Label>
        <select
          id={`${scope}-block-severity`}
          aria-label={`${scope} blocking severity`}
          className="hive-control sg-select"
          value={thresholds.blockOnSeverity ?? ''}
          disabled={disabled}
          onChange={(e) =>
            onChange({
              ...thresholds,
              blockOnSeverity: (e.target.value || null) as QualityThresholds['blockOnSeverity'],
            })
          }
        >
          <option value="">Not gated</option>
          {QUALITY_SEVERITY_OPTIONS.map((severity) => (
            <option key={severity} value={severity}>
              {severity} or worse
            </option>
          ))}
        </select>
      </div>

      <div className="qp-switch-row">
        <span className="qp-switch-row__text">
          <Label htmlFor={`${scope}-enforcement`} className="qp-switch-row__title">
            Refuse the {scope} when a floor is missed
          </Label>
          <span className="qp-switch-row__desc">
            {scope === 'import'
              ? 'Off keeps the policy advisory: the verdict is recorded but intake proceeds.'
              : 'Off keeps the policy advisory: the pre-flight verdict warns, delivery proceeds.'}
          </span>
        </span>
        <Switch
          id={`${scope}-enforcement`}
          aria-label={`Block ${scope} on policy failure`}
          checked={thresholds.enforcement === 'block'}
          disabled={disabled}
          onCheckedChange={(checked) =>
            onChange({ ...thresholds, enforcement: checked ? 'block' : 'advisory' })
          }
        />
      </div>
    </fieldset>
  );
}

/**
 * The import & export quality policy panel.
 *
 * @param props.readOnly Whether the viewer may save. A member sees every value and no Save.
 * @returns The policy form, the version list and the waiver ledger.
 */
export default function QualityPolicyPanel({ readOnly = false }: { readOnly?: boolean }) {
  const [policy, setPolicy] = useState<QualityPolicy | null>(null);
  const [baseline, setBaseline] = useState<PolicyDraft | null>(null);
  const [draft, setDraft] = useState<PolicyDraft | null>(null);
  const [versions, setVersions] = useState<QualityPolicy[]>([]);
  const [waivers, setWaivers] = useState<QualityWaiver[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  /** Load the policy in force, its version history, and the active waiver ledger. */
  const loadData = useCallback(async () => {
    setError('');
    setLoading(true);
    try {
      const [current, versionList, waiverList] = await Promise.all([
        qualityPolicyApi<QualityPolicy>(''),
        qualityPolicyApi<QualityPolicyVersionList>('versions'),
        qualityPolicyApi<QualityWaiverList>('waivers'),
      ]);
      if (current) {
        setPolicy(current);
        const next = toDraft(current);
        setBaseline(next);
        setDraft(next);
      }
      setVersions(versionList?.versions ?? []);
      setWaivers(waiverList?.waivers ?? []);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load the quality policy');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadData();
  }, [loadData]);

  const dirty = useMemo(
    () => (draft && baseline ? isDraftDirty(draft, baseline) : false),
    [draft, baseline]
  );

  /** Persist the draft as a new immutable version and refresh from the response. */
  const handleSave = async () => {
    if (!draft) return;
    setSaving(true);
    setError('');
    try {
      const saved = await qualityPolicyApi<QualityPolicy>('', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          import: draft.importPolicy,
          export: draft.exportPolicy,
          allowOverride: draft.allowOverride,
          overrideRoles: parseRoleList(draft.overrideRoles),
          waiverTtlHours: draft.waiverTtlHours,
        }),
      });
      if (saved) {
        setPolicy(saved);
        const next = toDraft(saved);
        setBaseline(next);
        setDraft(next);
      }
      const versionList = await qualityPolicyApi<QualityPolicyVersionList>('versions');
      setVersions(versionList?.versions ?? []);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to save the quality policy');
    } finally {
      setSaving(false);
    }
  };

  if (loading) {
    // Shaped like the form it is waiting for, rather than a spinner in the middle of an
    // empty page (DESIGN.md §8).
    return (
      <div className="qp-skeleton" data-testid="quality-policy-loading">
        <span className="sr-only" role="status">
          Loading the quality policy…
        </span>
        <Skeleton className="qp-skeleton__header" />
        <Skeleton className="qp-skeleton__block" />
        <Skeleton className="qp-skeleton__block" />
      </div>
    );
  }

  const disabled = readOnly || saving;

  return (
    <div className="qp-panel" data-testid="quality-policy-panel">
      {error && <Alert variant="error">{error}</Alert>}

      <Card>
        <CardHeader className="qp-card-header">
          <span className="qp-card-header__lead">
            <span className="tnt-icon-tile" data-tone="accent">
              <ShieldCheck aria-hidden />
            </span>
            <span className="qp-card-header__text">
              {/* `h3` takes its type from the unlayered base rules in `globals.css`, which
                  outrank every utility class — so it is not given one here. */}
              <h3 className="qp-card-title">Import &amp; export quality policy</h3>
              <p className="qp-card-desc">
                Applied when a document is imported and when an artifact is delivered.
                Resolution is per-format override → tenant → default.
              </p>
            </span>
          </span>
          {policy?.isDefault ? (
            <Badge variant="outline" data-testid="quality-policy-default-badge">
              Not configured — advisory
            </Badge>
          ) : (
            <Badge variant="outline" mono data-testid="quality-policy-version-badge">
              v{policy?.versionNumber}
            </Badge>
          )}
        </CardHeader>

        {draft && (
          <CardContent className="qp-body">
            <div className="qp-scopes">
              <ScopeFields
                scope="import"
                thresholds={draft.importPolicy}
                disabled={disabled}
                onChange={(importPolicy) => setDraft({ ...draft, importPolicy })}
              />
              <ScopeFields
                scope="export"
                thresholds={draft.exportPolicy}
                disabled={disabled}
                onChange={(exportPolicy) => setDraft({ ...draft, exportPolicy })}
              />
            </div>

            <fieldset className="qp-fieldset">
              <legend className="qp-legend">
                <FileSignature aria-hidden className="qp-legend__glyph" />
                Overrides
              </legend>
              <div className="qp-switch-row">
                <span className="qp-switch-row__text">
                  <Label htmlFor="allow-override" className="qp-switch-row__title">
                    Allow a blocked user to proceed by recording a waiver
                  </Label>
                  <span className="qp-switch-row__desc">
                    Waivers are accepted risk with a deadline; each one is listed under Active
                    waivers below.
                  </span>
                </span>
                <Switch
                  id="allow-override"
                  aria-label="Allow overrides"
                  checked={draft.allowOverride}
                  disabled={disabled}
                  onCheckedChange={(checked) => setDraft({ ...draft, allowOverride: checked })}
                />
              </div>
              <div className="qp-grid">
                <div className="sg-field">
                  <Label htmlFor="override-roles">Roles permitted to waive</Label>
                  <Input
                    id="override-roles"
                    aria-label="Roles permitted to waive"
                    className="mono"
                    value={draft.overrideRoles}
                    disabled={disabled || !draft.allowOverride}
                    onChange={(e) => setDraft({ ...draft, overrideRoles: e.target.value })}
                    placeholder={ROLE_OPTIONS.join(', ')}
                  />
                  <p className="sg-field__hint">
                    Comma-separated role slugs ({ROLE_OPTIONS.join(', ')}). Tenant administrators
                    resolve to <code className="mono">owner</code>. An empty list means nobody may
                    waive.
                  </p>
                </div>
                <div className="sg-field">
                  <Label htmlFor="waiver-ttl">Waiver lifetime (hours)</Label>
                  <Input
                    id="waiver-ttl"
                    aria-label="Waiver lifetime in hours"
                    type="number"
                    min={1}
                    max={8760}
                    className="sg-num"
                    value={draft.waiverTtlHours}
                    disabled={disabled || !draft.allowOverride}
                    onChange={(e) =>
                      setDraft({ ...draft, waiverTtlHours: Number(e.target.value) || 1 })
                    }
                  />
                  <p className="sg-field__hint">
                    A waiver is honoured until it expires; the waiver-expiry sweep warns before it
                    lapses.
                  </p>
                </div>
              </div>
            </fieldset>

            {/* Per-format overrides are read-only here: they are a rarely-edited, deeply nested
                map, and a save carries them forward untouched. They are shown so a surprising
                verdict whose `source` is `format_override` can be traced to the rule that caused
                it. Edit them through PUT /api/quality-policy. */}
            <div className="qp-overrides">
              <div className="qp-overrides__head">
                <span className="sg-section-title">Per-format overrides</span>
                <span className="sg-quiet">read-only · set via the REST policy API</span>
              </div>
              {Object.keys(policy?.formatOverrides ?? {}).length === 0 ? (
                <p className="sg-quiet">None. Every format uses the tenant floors above.</p>
              ) : (
                <ul className="qp-overrides__list" data-testid="quality-policy-format-overrides">
                  {Object.entries(policy?.formatOverrides ?? {}).map(([format, block]) => (
                    <li key={format} className="qp-overrides__row">
                      <code className="qp-overrides__format mono">{format}</code>
                      <span className="qp-overrides__value mono">{JSON.stringify(block)}</span>
                    </li>
                  ))}
                </ul>
              )}
              <p className="sg-field__hint">
                Resolution is format override → tenant → default; the pre-flight verdict names the
                tier that won.
              </p>
            </div>
          </CardContent>
        )}

        {/* No draft means the read failed, so there is nothing to save and nothing to say
            about saving — the error alert above is the whole of the panel in that state. */}
        {draft && (
        <CardFooter>
          <span className="sg-quiet">
            {readOnly
              ? 'Read-only: only tenant administrators can save a policy version.'
              : policy?.isDefault
                ? 'Saving creates the first immutable policy version.'
                : `Saving creates an immutable policy version; the current one is v${policy?.versionNumber}.`}
          </span>
          {!readOnly && (
            <Button
              disabled={saving || !dirty}
              data-testid="quality-policy-save"
              onClick={() => void handleSave()}
            >
              {saving ? <Spinner size="sm" aria-hidden /> : null}
              {saving ? 'Saving…' : 'Save policy'}
            </Button>
          )}
        </CardFooter>
        )}
      </Card>

      <div className="qp-lists">
        <Card>
          <CardHeader className="qp-list-header">
            <span className="qp-card-header__text">
              <h3 className="qp-card-title">
                <History aria-hidden className="qp-card-title__glyph" />
                Policy versions
              </h3>
              <p className="qp-card-desc">
                Immutable snapshots; every verdict names the version it applied.
              </p>
            </span>
          </CardHeader>
          {versions.length === 0 ? (
            <CardContent>
              <p className="sg-quiet">No policy has been saved yet.</p>
            </CardContent>
          ) : (
            <ul className="qp-rows" data-testid="quality-policy-versions">
              {versions.map((version) => (
                <li
                  key={version.policyVersionId ?? version.versionNumber}
                  className="qp-version-row"
                >
                  <Badge variant="outline" mono>
                    v{version.versionNumber}
                  </Badge>
                  <code className="qp-fingerprint mono" title={version.contentFingerprint}>
                    {version.contentFingerprint.slice(0, 12)}…
                  </code>
                  <span className="qp-version-row__when">
                    {formatPolicyInstant(version.createdAt)}
                  </span>
                  {version.actorLabel && (
                    <span className="qp-version-row__actor">{version.actorLabel}</span>
                  )}
                </li>
              ))}
            </ul>
          )}
        </Card>

        <Card>
          <CardHeader className="qp-list-header">
            <span className="qp-card-header__text">
              <h3 className="qp-card-title">
                <FileSignature aria-hidden className="qp-card-title__glyph" />
                Active waivers
              </h3>
              <p className="qp-card-desc">
                Accepted risk with a deadline, recorded when someone proceeded against this
                policy.
              </p>
            </span>
            {waivers.length > 0 && <Badge variant="warn">{waivers.length}</Badge>}
          </CardHeader>
          {waivers.length === 0 ? (
            <CardContent>
              <p className="sg-quiet">No active waivers.</p>
            </CardContent>
          ) : (
            <ul className="qp-rows" data-testid="quality-policy-waivers">
              {waivers.map((waiver) => (
                <li key={waiver.id} className="qp-waiver-row">
                  <span className="tnt-icon-tile" data-tone="warn">
                    <FileSignature aria-hidden />
                  </span>
                  <span className="qp-waiver-row__text">
                    <span className="qp-waiver-row__head">
                      <span className="qp-waiver-row__subject">
                        {waiver.subjectLabel || waiver.subjectKey.slice(0, 12)}
                      </span>
                      <Badge variant="outline">
                        {waiver.scope}
                        {waiver.formatKey ? ` · ${waiver.formatKey}` : ''}
                      </Badge>
                      {waiver.grade && (
                        <span className="sg-quiet">
                          graded {waiver.grade}
                          {typeof waiver.score === 'number' ? ` (${waiver.score})` : ''}
                        </span>
                      )}
                    </span>
                    <span className="qp-waiver-row__reason">{waiver.reason}</span>
                    <span className="qp-waiver-row__meta">
                      {waiver.actorLabel ?? 'unknown actor'}
                      {waiver.actorRole ? ` (${waiver.actorRole})` : ''} · expires{' '}
                      {formatPolicyInstant(waiver.expiresAt)}
                    </span>
                  </span>
                </li>
              ))}
            </ul>
          )}
        </Card>
      </div>
    </div>
  );
}
