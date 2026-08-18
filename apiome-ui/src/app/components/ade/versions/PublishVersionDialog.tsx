'use client';

/**
 * The Publish dialog (HIVE-6.2, #5313).
 *
 * Authority: `docs/mockups/build/versions.html` §Publish version (with guardrails) — a
 * two-column `dialog--xl`: the form on the left (visibility as two selectable cards, the
 * revision note, the changelog, the `[gitlike]` publication change report, force publish and
 * its reason) and the three **publish gates** on the right (style guide, breaking changes,
 * verification policy).
 *
 * ### The gates block or allow exactly as before
 *
 * The three panels are the same components — `PublishGuideViolationsPanel`,
 * `BreakingPublishGuardrailPanel`, `VerificationPolicyDecisionPanel` — with the same props and
 * the same `on…Change` callbacks; the screen still derives `publishBlockedByGuideErrors`,
 * `publishBlockedByVerificationPolicy`, `publishBlockedByBreakingGuardrail` and
 * `publishForceReasonMissing` from what they report, and still disables the Publish button on
 * their union. This dialog receives those four booleans and draws them; it decides nothing.
 *
 * ### Force publish
 *
 * The checkbox, the amber "prechecks will be bypassed" banner and the required reason are 1:1
 * with the screen this replaces; the reason field is marked invalid (and says so) the moment
 * force is on and the reason is empty, which is the mockup's `.field.is-invalid`.
 *
 * ### The publication change report
 *
 * `FEATURE_GITLIKE` (and `NEXT_PUBLIC_CHANGE_REPORT_UI`) data. When the screen says it is
 * enabled the card is drawn in full; in a non-production build with the flag off, only its
 * head is drawn with the honey flag, so the gap is legible; in production with the flag off,
 * nothing — the same three rows as every other git-like affordance.
 */

import * as React from 'react';
import { Lock, RefreshCw, TriangleAlert } from 'lucide-react';

import { Alert } from '@/app/components/ui/Alert';
import { Button } from '@/app/components/ui/Button';
import { Checkbox } from '@/app/components/ui/Checkbox';
import { Dialog, DialogContent, DialogFooter } from '@/app/components/ui/Dialog';
import { FormField } from '@/app/components/ui/FormField';
import { Input } from '@/app/components/ui/Input';
import { Markdown } from '@/app/components/ui/Markdown';
import { RadioGroup, RadioGroupItem } from '@/app/components/ui/RadioGroup';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/app/components/ui/Select';
import { Textarea } from '@/app/components/ui/Textarea';
import { PublishGuideViolationsPanel } from '@/app/components/ade/dashboard/PublishGuideViolationsPanel';
import { BreakingPublishGuardrailPanel } from '@/app/components/ade/dashboard/BreakingPublishGuardrailPanel';
import VerificationPolicyDecisionPanel from '@/app/components/ade/dashboard/VerificationPolicyDecisionPanel';
import type { BreakingPublishGuardrail } from '@/app/utils/breaking-publish-guardrail';
import type { VersionLintReport } from '@/app/utils/version-lint-report';
import type { VerificationPolicyDecision } from '@/app/ade/dashboard/style-guides/verification-policy-api';
import { cn } from '@lib/utils';

import { GitlikeFlag } from './GitlikeFlag';
import { VersionDialogHead } from './VersionDialogChrome';
import { versionLabel, type GitlikeAffordance, type Version } from './versionsModel';

/** The two visibilities a published revision can have. */
export type PublishVisibility = 'private' | 'public';

/** How the change report picks its baseline. */
export type PublishChangeReportBaselineMode = 'auto' | 'initial' | 'manual';

/** The change-report preview, as the screen holds it. */
export interface PublishChangeReportPreview {
  headerSnapshot: string;
  renderedBody: string;
  footnoteSnapshot: string;
  initialPublication?: boolean;
  fromVersionLabel?: string;
  toVersionLabel?: string;
}

/** Everything the publication change report card needs, when the screen has it enabled. */
export interface PublishChangeReportProps {
  baselineMode: PublishChangeReportBaselineMode;
  onBaselineModeChange: (next: PublishChangeReportBaselineMode) => void;
  manualBaselineRevisionId: string;
  onManualBaselineRevisionIdChange: (next: string) => void;
  /** The other published revisions of the project, newest label first. */
  manualBaselineOptions: readonly Version[];
  previewLoading: boolean;
  previewError: string | null;
  preview: PublishChangeReportPreview | null;
  onRefreshPreview: () => void;
}

/** The four reasons the Publish button can be inert. */
export interface PublishBlockers {
  guideErrors: boolean;
  verificationPolicy: boolean;
  breakingGuardrail: boolean;
  forceReasonMissing: boolean;
}

export interface PublishVersionDialogProps {
  open: boolean;
  /** Called with `false` to close. */
  onOpenChange: (open: boolean) => void;
  /** The revision being published, or `null` before one is chosen. */
  version: Version | null;
  /** The owning project's slug, for the verification policy evaluation. */
  projectSlug?: string;
  visibility: PublishVisibility;
  onVisibilityChange: (next: PublishVisibility) => void;
  /** The revision note frozen with this publish. */
  note: string;
  onNoteChange: (next: string) => void;
  changelog: string;
  onChangelogChange: (next: string) => void;
  force: boolean;
  onForceChange: (next: boolean) => void;
  forceReason: string;
  onForceReasonChange: (next: string) => void;
  /** The three gate panels report through these — the screen's callbacks, unchanged. */
  onLintReportChange: (report: VersionLintReport | null) => void;
  onGuardrailChange: (guardrail: BreakingPublishGuardrail | null) => void;
  onDecisionChange: (decision: VerificationPolicyDecision | null) => void;
  /** What is holding the Publish button, as the screen derived it. */
  blockers: PublishBlockers;
  /** The guardrail's recommended version, for the footer's blocked note. */
  recommendedVersion?: string | null;
  /** Whether the change report UI is enabled (`FEATURE_GITLIKE` and the env opt-in). */
  changeReportEnabled: boolean;
  /** The change report card's props, when enabled. */
  changeReport?: PublishChangeReportProps;
  /** How git-like affordances are treated in this build. */
  gitlike: GitlikeAffordance;
  onSubmit: () => void;
}

/**
 * Render the dialog. See {@link PublishVersionDialogProps}.
 *
 * @returns The dialog.
 */
export default function PublishVersionDialog({
  open,
  onOpenChange,
  version,
  projectSlug,
  visibility,
  onVisibilityChange,
  note,
  onNoteChange,
  changelog,
  onChangelogChange,
  force,
  onForceChange,
  forceReason,
  onForceReasonChange,
  onLintReportChange,
  onGuardrailChange,
  onDecisionChange,
  blockers,
  recommendedVersion,
  changeReportEnabled,
  changeReport,
  gitlike,
  onSubmit,
}: PublishVersionDialogProps) {
  const blocked =
    blockers.guideErrors ||
    blockers.verificationPolicy ||
    blockers.breakingGuardrail ||
    blockers.forceReasonMissing;

  /** The sentence under the footer's buttons while the button is inert. */
  const blockedNote = blockers.forceReasonMissing
    ? 'Enter a reason for force publishing — it is recorded in the audit trail.'
    : blockers.guideErrors
      ? 'Resolve style-guide error violations or enable force publish with a reason.'
      : blockers.breakingGuardrail
        ? `This revision has breaking changes without a major-version bump. Publish as ${
            recommendedVersion ?? 'the next major version'
          } or enable force publish with a reason.`
        : blockers.verificationPolicy
          ? 'Resolve verification-policy gates or enable force publish with a reason.'
          : null;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent size="xl" className="ver-dialog" data-testid="publish-version-dialog">
        <VersionDialogHead
          icon={<Lock />}
          tone="ok"
          title={version ? `Publish ${versionLabel(version)}` : 'Publish version'}
          description="Once published, this version will become read-only. To make any additional edits after publishing, either create a new version, or unpublish this version."
        />

        <div className="ver-dialog__body">
          <div className="ver-publish">
            <div className="ver-publish__form">
              <fieldset className="ver-field">
                <legend className="ver-field__label">Visibility</legend>
                <RadioGroup
                  value={visibility}
                  onValueChange={(next) => onVisibilityChange(next as PublishVisibility)}
                  className="ver-publish__visibility"
                  aria-label="Visibility"
                >
                  <RadioGroupItem
                    value="private"
                    id="publish-visibility-private"
                    data-testid="publish-visibility-private"
                    className={cn('ver-radio-card', visibility === 'private' && 'is-selected')}
                    label={
                      <>
                        <span className="ver-radio-card__title">Private</span>
                        <span className="ver-radio-card__desc">Access requires an API Key.</span>
                      </>
                    }
                  />
                  <RadioGroupItem
                    value="public"
                    id="publish-visibility-public"
                    data-testid="publish-visibility-public"
                    className={cn('ver-radio-card', visibility === 'public' && 'is-selected')}
                    label={
                      <>
                        <span className="ver-radio-card__title">Public</span>
                        <span className="ver-radio-card__desc">
                          OpenAPI Specification will be public without requiring an API Key.
                        </span>
                      </>
                    }
                  />
                </RadioGroup>
              </fieldset>

              <FormField label="Revision note" htmlFor="publish-note" required helperText="Short summary frozen with this publish">
                <Input
                  id="publish-note"
                  value={note}
                  onChange={(event) => onNoteChange(event.target.value)}
                  placeholder="Short summary frozen with this publish"
                  data-testid="publish-note"
                />
              </FormField>
              <FormField
                label="Changelog (markdown)"
                htmlFor="publish-changelog"
                helperText="Release notes; use - breaking: lines for migration docs"
              >
                <Textarea
                  id="publish-changelog"
                  className="mono"
                  value={changelog}
                  onChange={(event) => onChangelogChange(event.target.value)}
                  rows={5}
                  placeholder="Release notes; use - breaking: lines for migration docs"
                />
              </FormField>

              {changeReportEnabled && changeReport ? (
                <PublicationChangeReportCard {...changeReport} gitlike={gitlike} versions={changeReport.manualBaselineOptions} />
              ) : !changeReportEnabled && gitlike.visible && !gitlike.flagOn ? (
                <div className="ver-cr ver-cr--inert" data-testid="publish-change-report-inert">
                  <div className="ver-cr__head">
                    <span className="ver-cr__title">
                      Publication change report
                      {gitlike.marked ? <GitlikeFlag enabled={false} /> : null}
                    </span>
                  </div>
                  <p className="ver-cr__note">
                    A change report is generated when you publish. Compiled but hidden today
                    (FEATURE_GITLIKE=false).
                  </p>
                </div>
              ) : null}

              <div className="ver-publish__force">
                <label className="ver-check" htmlFor="publish-force">
                  <Checkbox
                    id="publish-force"
                    checked={force}
                    onCheckedChange={(checked) => onForceChange(checked === true)}
                    data-testid="publish-force"
                  />
                  <span>Force publish (ignore validation errors)</span>
                </label>
                {force ? (
                  <>
                    <Alert variant="warning" icon={<TriangleAlert aria-hidden />}>
                      Publish prechecks will be bypassed — missing class descriptions, OpenAPI build,
                      backward-compatibility gates, style-guide error violations, the breaking-change
                      guardrail, and evidence-backed verification policy are not enforced. A reason is
                      required and recorded in the audit trail.
                    </Alert>
                    <FormField
                      label="Force publish reason"
                      htmlFor="publish-force-reason"
                      required
                      error={
                        blockers.forceReasonMissing
                          ? 'Enter a reason for force publishing — it is recorded in the audit trail.'
                          : undefined
                      }
                    >
                      <Textarea
                        id="publish-force-reason"
                        value={forceReason}
                        onChange={(event) => onForceReasonChange(event.target.value)}
                        rows={3}
                        placeholder="Why the gates are being bypassed (audit trail)"
                        data-testid="publish-force-reason"
                      />
                    </FormField>
                  </>
                ) : null}
              </div>
            </div>

            <aside className="ver-publish__gates" aria-labelledby="publish-gates-title">
              <h3 id="publish-gates-title" className="ver-publish__gates-title">
                Publish gates
              </h3>
              {version ? (
                <>
                  <PublishGuideViolationsPanel
                    projectId={version.project_id}
                    versionId={version.id}
                    onReportChange={(report) => onLintReportChange(report)}
                  />
                  <BreakingPublishGuardrailPanel
                    projectId={version.project_id}
                    versionId={version.id}
                    enabled={open}
                    onGuardrailChange={(guardrail) => onGuardrailChange(guardrail)}
                  />
                  <VerificationPolicyDecisionPanel
                    projectId={version.project_id}
                    versionId={version.id}
                    projectSlug={projectSlug}
                    versionSlug={version.version_id}
                    enabled={open}
                    onDecisionChange={onDecisionChange}
                  />
                </>
              ) : null}
            </aside>
          </div>
        </div>

        <DialogFooter className="ver-dialog__footer">
          {blockedNote ? (
            <span className="ver-dialog__footnote" role="status" data-testid="publish-blocked-note">
              {blockedNote}
            </span>
          ) : null}
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            onClick={onSubmit}
            disabled={blocked}
            title={blocked && blockedNote ? blockedNote : undefined}
            data-testid="publish-submit"
          >
            Publish
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** Props for {@link PublicationChangeReportCard}. */
interface PublicationChangeReportCardProps extends PublishChangeReportProps {
  gitlike: GitlikeAffordance;
  versions: readonly Version[];
}

/**
 * The publication change report card — baseline mode, the manual pick, and the preview.
 *
 * @param props See {@link PublicationChangeReportCardProps}.
 * @returns The card.
 */
function PublicationChangeReportCard({
  baselineMode,
  onBaselineModeChange,
  manualBaselineRevisionId,
  onManualBaselineRevisionIdChange,
  manualBaselineOptions,
  previewLoading,
  previewError,
  preview,
  onRefreshPreview,
  gitlike,
}: PublicationChangeReportCardProps) {
  return (
    <div className="ver-cr" data-testid="publish-change-report">
      <div className="ver-cr__head">
        <span className="ver-cr__title">
          Publication change report
          {gitlike.marked ? <GitlikeFlag enabled={gitlike.enabled} /> : null}
        </span>
        <Button variant="ghost" size="sm" onClick={onRefreshPreview} disabled={previewLoading}>
          <RefreshCw aria-hidden />
          {previewLoading ? 'Loading preview…' : 'Refresh preview'}
        </Button>
      </div>
      <p className="ver-cr__note">
        A change report is generated when you publish. Choose what to compare this revision
        against, then review the draft below.
      </p>
      <div className="ver-dialog__grid">
        <FormField
          label="Compare against"
          htmlFor="publish-cr-baseline-mode"
          helperText={
            manualBaselineOptions.length === 0
              ? 'No other published revisions in this project — use "Initial publication report only" or Automatic.'
              : undefined
          }
        >
          <Select
            value={baselineMode}
            onValueChange={(value) => onBaselineModeChange(value as PublishChangeReportBaselineMode)}
          >
            <SelectTrigger id="publish-cr-baseline-mode">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="auto">Automatic (recommended prior published revision)</SelectItem>
              <SelectItem value="initial">Initial publication report only (no prior baseline)</SelectItem>
              <SelectItem value="manual" disabled={manualBaselineOptions.length === 0}>
                Choose a published revision…
              </SelectItem>
            </SelectContent>
          </Select>
        </FormField>
        {baselineMode === 'manual' && manualBaselineOptions.length > 0 ? (
          <FormField label="Published revision" htmlFor="publish-cr-baseline-pick">
            <Select value={manualBaselineRevisionId} onValueChange={onManualBaselineRevisionIdChange}>
              <SelectTrigger id="publish-cr-baseline-pick">
                <SelectValue placeholder="Select revision…" />
              </SelectTrigger>
              <SelectContent>
                {manualBaselineOptions.map((candidate) => (
                  <SelectItem key={candidate.id} value={candidate.id}>
                    v{candidate.version_id}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </FormField>
        ) : null}
      </div>
      {preview ? (
        <p className="ver-cr__pair">
          {preview.initialPublication
            ? 'Initial publication report'
            : `Diff: ${preview.fromVersionLabel ?? '—'} → ${preview.toVersionLabel ?? '—'}`}
        </p>
      ) : null}
      {previewError ? <Alert variant="warning">{previewError}</Alert> : null}
      {previewLoading && !preview ? <p className="ver-cr__note">Generating preview…</p> : null}
      {preview ? (
        <div className="ver-cr__preview">
          <Markdown variant="default" className="ver-cr__preview-part">
            {preview.headerSnapshot || '—'}
          </Markdown>
          <Markdown variant="default" className="ver-cr__preview-part">
            {preview.renderedBody || '—'}
          </Markdown>
          <Markdown variant="default">{preview.footnoteSnapshot || '—'}</Markdown>
        </div>
      ) : null}
    </div>
  );
}
