'use client';

/**
 * The New version dialog (HIVE-6.2, #5313).
 *
 * Authority: `docs/mockups/build/versions.html` §New version — three sections: *Copy source*
 * (the copy-from select, the branch-context lineage snippet, the compatibility note),
 * *Version* (strategy, bump, the "Version 2.5.0 will be created" hint or the manual id) and
 * *Describe the release* (message, external reference, changelog, each with its limit).
 *
 * The state is the screen's — every value and setter comes in as a prop — because the
 * submit handler that reads them (`handleCreateSubmit`, with its STALE_HEAD handling and its
 * branch-tip resolution) is untouched by this ticket. What this owns is the shape.
 *
 * With two or more named branches the copy-source select becomes *Base copy on branch tip*,
 * exactly as before; with fewer, the hint says so and carries the honey flag in a
 * non-production build, since that mode is `FEATURE_GITLIKE` data.
 */

import * as React from 'react';
import { GitFork, Info } from 'lucide-react';

import { Alert } from '@/app/components/ui/Alert';
import { Button } from '@/app/components/ui/Button';
import { Dialog, DialogContent, DialogFooter } from '@/app/components/ui/Dialog';
import { FormField } from '@/app/components/ui/FormField';
import { Input } from '@/app/components/ui/Input';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/app/components/ui/Select';
import { Textarea } from '@/app/components/ui/Textarea';
import VersionLineageSnippet from '@/app/ade/dashboard/versions/VersionLineageSnippet';
import { COMMIT_EXTERNAL_REF_MAX_CHARS, VERSION_NOTES_LIMITS } from '@lib/version-notes';

import { GitlikeFlag } from './GitlikeFlag';
import { VersionDialogHead } from './VersionDialogChrome';
import type { GitlikeAffordance, Version, VersionBranchRow } from './versionsModel';

/** Radix `Select` cannot use the empty string as a value; this stands in for "blank". */
const BLANK_SOURCE = '__blank__';

/** The two bump strategies the auto-generated version offers. */
export type BumpStrategy = 'patch' | 'minor';

export interface NewVersionDialogProps {
  open: boolean;
  /** Called with `false` to close. The screen refuses while a create is in flight. */
  onOpenChange: (open: boolean) => void;
  /** True while the create is in flight. */
  busy: boolean;
  /** The screen's error line, `''` for none. */
  error: string;
  /** The loaded revisions, for the copy-from select. */
  versions: readonly Version[];
  /** The named branches, for the branch-tip mode. */
  branches: readonly VersionBranchRow[];
  branchListLoading: boolean;
  branchListError: string | null;
  branchPermissionDenied: boolean;
  /** `'blank'` or `branch:<id>` — the branch-tip mode's value. */
  copySourceBranchKey: string;
  onCopySourceBranchKeyChange: (next: string) => void;
  /** The revision to copy from, `''` for a blank version. */
  sourceVersionId: string;
  onSourceVersionIdChange: (next: string) => void;
  autoGenerate: boolean;
  onAutoGenerateChange: (next: boolean) => void;
  bumpStrategy: BumpStrategy;
  onBumpStrategyChange: (next: BumpStrategy) => void;
  /** The version the current strategy would mint. */
  nextAutoVersion: string;
  /** What each strategy would mint — for the two option labels. */
  previewFor: (strategy: BumpStrategy) => string;
  /** The manual version id. */
  versionId: string;
  onVersionIdChange: (next: string) => void;
  /** The revision note. */
  message: string;
  onMessageChange: (next: string) => void;
  /** The validation error for the note, when it is non-empty and invalid. */
  messageError: string | null;
  externalRef: string;
  onExternalRefChange: (next: string) => void;
  externalRefOverLimit: boolean;
  changelog: string;
  onChangelogChange: (next: string) => void;
  changelogOverLimit: boolean;
  /** Whether the form may be submitted. */
  canSubmit: boolean;
  onSubmit: () => void;
  /** How git-like affordances are treated in this build. */
  gitlike: GitlikeAffordance;
}

/**
 * Render the dialog. See {@link NewVersionDialogProps}.
 *
 * @returns The dialog.
 */
export default function NewVersionDialog({
  open,
  onOpenChange,
  busy,
  error,
  versions,
  branches,
  branchListLoading,
  branchListError,
  branchPermissionDenied,
  copySourceBranchKey,
  onCopySourceBranchKeyChange,
  sourceVersionId,
  onSourceVersionIdChange,
  autoGenerate,
  onAutoGenerateChange,
  bumpStrategy,
  onBumpStrategyChange,
  nextAutoVersion,
  previewFor,
  versionId,
  onVersionIdChange,
  message,
  onMessageChange,
  messageError,
  externalRef,
  onExternalRefChange,
  externalRefOverLimit,
  changelog,
  onChangelogChange,
  changelogOverLimit,
  canSubmit,
  onSubmit,
  gitlike,
}: NewVersionDialogProps) {
  const branchTipMode = branches.length > 1;

  /** The branch name the lineage snippet should name as primary context, if any. */
  const explicitBranchName = branchTipMode
    ? copySourceBranchKey.startsWith('branch:')
      ? (branches.find((branch) => branch.id === copySourceBranchKey.slice(7))?.name ?? null)
      : null
    : branches.length === 1 && branches[0].tip_version_id === sourceVersionId
      ? branches[0].name
      : null;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        size="lg"
        className="ver-dialog"
        data-testid="new-version-dialog"
      >
        <VersionDialogHead
          icon={<GitFork />}
          tone="ok"
          title="New version"
          description="Start a new schema version for this project. Pick a bump strategy (defaults to minor), then describe the release."
        />

        <div className="ver-dialog__body">
          {error ? <Alert variant="error">{error}</Alert> : null}
          {branchListError ? (
            <Alert variant="warning" role="status">
              {branchListError} Branch names may be missing; you can still pick a revision below if
              your role allows.
            </Alert>
          ) : null}

          <section className="ver-form-section">
            <h3 className="ver-form-section__title">Copy source</h3>
            <div className="ver-dialog__grid">
              {branchTipMode ? (
                <FormField
                  label="Base copy on branch tip"
                  htmlFor="create-copy-branch"
                  helperText="Multiple branches are defined for this project. Choose which branch tip to copy schema from—like picking which line to extend in git."
                >
                  <Select
                    value={copySourceBranchKey}
                    onValueChange={onCopySourceBranchKeyChange}
                    disabled={branchListLoading}
                  >
                    <SelectTrigger id="create-copy-branch" data-testid="new-version-copy-branch">
                      <SelectValue
                        placeholder={branchListLoading ? 'Loading branches…' : 'Choose branch tip or blank'}
                      />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="blank">Create blank version</SelectItem>
                      {branches.map((branch) => (
                        <SelectItem key={branch.id} value={`branch:${branch.id}`}>
                          {branch.name} — tip v{branch.tip_version_string ?? '?'}
                          {branch.protected ? ' (protected)' : ''}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </FormField>
              ) : (
                <div className="ver-field">
                  <FormField label="Copy from version" htmlFor="create-copy-source">
                    <Select
                      value={sourceVersionId || BLANK_SOURCE}
                      onValueChange={(value) => onSourceVersionIdChange(value === BLANK_SOURCE ? '' : value)}
                    >
                      <SelectTrigger id="create-copy-source" data-testid="new-version-copy-source">
                        <SelectValue
                          placeholder={versions.length === 0 ? 'No versions available' : 'Create blank version'}
                        />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value={BLANK_SOURCE}>Create blank version</SelectItem>
                        {versions.map((version) => (
                          <SelectItem key={version.id} value={version.id}>
                            {version.published ? '🔒 ' : ''}v{version.version_id} - {version.shortMessage || 'No description'}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </FormField>
                  <p className="ver-hint">
                    With ≥2 named branches this becomes “Base copy on branch tip” — like picking which
                    line to extend in git.{' '}
                    {gitlike.marked ? <GitlikeFlag enabled={gitlike.enabled} /> : null}
                  </p>
                </div>
              )}

              {sourceVersionId ? (
                <VersionLineageSnippet
                  sourceVersionId={sourceVersionId}
                  versions={versions.map((version) => ({
                    id: version.id,
                    version_id: version.version_id,
                    parent_version_id: version.parent_version_id ?? null,
                    merge_parent_version_id: version.merge_parent_version_id ?? null,
                  }))}
                  versionBranches={branches.map((branch) => ({ name: branch.name, tip_version_id: branch.tip_version_id }))}
                  explicitBranchName={explicitBranchName}
                  isLoading={branchListLoading}
                  permissionDenied={branchPermissionDenied}
                />
              ) : null}
            </div>

            {sourceVersionId ? (
              <Alert variant="info" className="ver-dialog__note" icon={<Info aria-hidden />}>
                Classes and properties will be copied from the selected revision.
                <p className="ver-dialog__subnote">
                  <span className="ver-dialog__subnote-title">Compatibility</span> — after you create a
                  new version, the service records a parent→head compatibility check in the workflow
                  audit log. Use <strong>Merge branches</strong> on this page or{' '}
                  <strong>Compare versions</strong> to review a full grouped report between two
                  existing revisions before you integrate.
                </p>
              </Alert>
            ) : null}
          </section>

          <section className="ver-form-section">
            <h3 className="ver-form-section__title">Version</h3>
            <div className="ver-dialog__grid">
              <FormField label="Version strategy" htmlFor="create-version-strategy">
                <Select
                  value={autoGenerate ? 'auto' : 'manual'}
                  onValueChange={(value) => onAutoGenerateChange(value === 'auto')}
                >
                  <SelectTrigger id="create-version-strategy" data-testid="new-version-strategy">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="auto">Auto-generate version</SelectItem>
                    <SelectItem value="manual">Manual entry</SelectItem>
                  </SelectContent>
                </Select>
              </FormField>
              {autoGenerate ? (
                <FormField label="Bump strategy" htmlFor="create-bump-strategy">
                  <Select
                    value={bumpStrategy}
                    onValueChange={(value) => onBumpStrategyChange(value as BumpStrategy)}
                  >
                    <SelectTrigger id="create-bump-strategy" data-testid="new-version-bump">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="patch">Patch - {previewFor('patch')}</SelectItem>
                      <SelectItem value="minor">Minor - {previewFor('minor')}</SelectItem>
                    </SelectContent>
                  </Select>
                  <p className="ver-hint ver-hint--row" data-testid="new-version-preview">
                    <Info aria-hidden />
                    Version <span className="mono ver-hint__em">{nextAutoVersion}</span> will be created
                  </p>
                </FormField>
              ) : (
                <FormField label="Version ID" htmlFor="create-version-id">
                  <Input
                    id="create-version-id"
                    className="mono"
                    value={versionId}
                    onChange={(event) => onVersionIdChange(event.target.value)}
                    placeholder="e.g., 1.0.0"
                    disabled={busy}
                    data-testid="new-version-id"
                  />
                </FormField>
              )}
            </div>
          </section>

          <section className="ver-form-section">
            <h3 className="ver-form-section__title">Describe the release</h3>
            <div className="ver-dialog__stack">
              <FormField label="Message" htmlFor="commit-message" required error={messageError ?? undefined}>
                <Textarea
                  id="commit-message"
                  value={message}
                  onChange={(event) => onMessageChange(event.target.value)}
                  disabled={busy}
                  rows={3}
                  placeholder="Short summary (commit message)"
                  data-testid="new-version-message"
                />
              </FormField>
              <div className="ver-dialog__grid">
                <FormField
                  label="External reference (optional)"
                  htmlFor="commit-external-ref"
                  error={
                    externalRefOverLimit
                      ? `External reference must be at most ${COMMIT_EXTERNAL_REF_MAX_CHARS} characters`
                      : undefined
                  }
                  helperText={`External reference must be at most ${COMMIT_EXTERNAL_REF_MAX_CHARS} characters.`}
                >
                  <Input
                    id="commit-external-ref"
                    value={externalRef}
                    onChange={(event) => onExternalRefChange(event.target.value)}
                    disabled={busy}
                    placeholder="e.g. LINEAR-42, JIRA-123"
                  />
                </FormField>
                <FormField
                  label="Changelog (markdown, optional)"
                  htmlFor="commit-changelog"
                  error={
                    changelogOverLimit
                      ? `Changelog exceeds ${VERSION_NOTES_LIMITS.maxChangelogChars} characters`
                      : undefined
                  }
                >
                  <Textarea
                    id="commit-changelog"
                    className="mono"
                    value={changelog}
                    onChange={(event) => onChangelogChange(event.target.value)}
                    rows={3}
                    disabled={busy}
                    placeholder="Release notes, breaking bullets (- breaking: …)"
                  />
                </FormField>
              </div>
            </div>
          </section>
        </div>

        <DialogFooter className="ver-dialog__footer">
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={busy}>
            Cancel
          </Button>
          <Button onClick={onSubmit} disabled={busy || !canSubmit} data-testid="new-version-submit">
            {busy ? 'Creating…' : 'Create version'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
