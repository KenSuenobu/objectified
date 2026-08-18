'use client';

/**
 * The version-tags and named-branches chip panels (HIVE-6.2, #5313).
 *
 * Authority: `docs/mockups/build/versions.html` §Version tags + Named branches — two chip
 * groups on one card, each with its caps label, a honey `gitlike` flag, and Protect /
 * Unprotect / Remove beside the chips the viewer may act on.
 *
 * Both are `FEATURE_GITLIKE` surfaces and both are data-driven: the screen mounts this only
 * when the flag is on *and* the project has tags or branches, exactly as before. What changes
 * is the skin — the two `bg-amber-50/80` / `bg-gray-50` pill rows become the mockup's chips —
 * and the flag marker beside each label in a non-production build.
 *
 * The permission rules are the screen's, unchanged, and passed in as already-decided
 * booleans by the caller-supplied predicates so this component holds no policy of its own.
 */

import * as React from 'react';
import { GitBranch, Lock, Shield, Tag } from 'lucide-react';

import { Badge } from '@/app/components/ui/Badge';
import { Button } from '@/app/components/ui/Button';
import { Card } from '@/app/components/ui/Card';
import { cn } from '@lib/utils';

import { GitlikeFlag } from './GitlikeFlag';
import {
  isVersionBranchNonDeletable,
  type GitlikeAffordance,
  type VersionBranchRow,
  type VersionTagRow,
} from './versionsModel';

export interface VersionGitlikePanelsProps {
  /** The project's tags. */
  tags: readonly VersionTagRow[];
  /** The project's named branches. */
  branches: readonly VersionBranchRow[];
  /** Whether the viewer is a tenant admin (resolved). */
  effectiveIsAdmin: boolean;
  /** The viewer's user id. */
  currentUserId: string | undefined;
  /** How git-like affordances are treated in this build. */
  gitlike: GitlikeAffordance;
  /** Protect or unprotect a tag. */
  onToggleTagProtection: (tagId: string, next: boolean) => void;
  /** Remove a tag. */
  onDeleteTag: (tagId: string) => void;
  /** Protect or unprotect a branch. */
  onToggleBranchProtection: (branchId: string, next: boolean) => void;
  /** Remove a branch. */
  onDeleteBranch: (branchId: string) => void;
}

/**
 * Render the two chip groups. See {@link VersionGitlikePanelsProps}.
 *
 * @returns The card, or `null` when there is neither a tag nor a branch.
 */
export default function VersionGitlikePanels({
  tags,
  branches,
  effectiveIsAdmin,
  currentUserId,
  gitlike,
  onToggleTagProtection,
  onDeleteTag,
  onToggleBranchProtection,
  onDeleteBranch,
}: VersionGitlikePanelsProps) {
  if (tags.length === 0 && branches.length === 0) return null;

  return (
    <Card className="ver-gitlike" data-testid="versions-gitlike-panels">
      <div className="ver-gitlike__row">
        {tags.length > 0 ? (
          <div className="ver-gitlike__group" data-testid="versions-tags-panel">
            <span className="ver-gitlike__label">
              <Tag aria-hidden />
              Version tags
            </span>
            {gitlike.marked ? <GitlikeFlag enabled={gitlike.enabled} /> : null}
            {tags.map((tag) => {
              const canProtect = effectiveIsAdmin && !tag.immutable;
              const canRemove =
                !tag.immutable && (effectiveIsAdmin || (!tag.protected && tag.created_by === currentUserId));
              return (
                <span key={tag.id} className="ver-gitlike__chip-set">
                  <span
                    className="ver-chip"
                    title={
                      tag.channel
                        ? `Release channel: ${tag.channel}${tag.protected ? ' · protected' : ''}`
                        : tag.message
                          ? `Message: ${tag.message}`
                          : tag.name
                    }
                  >
                    <Tag aria-hidden />
                    <span className="mono">{tag.name}</span> → v{tag.target_version_string ?? '?'}
                    {tag.channel ? <Badge variant="outline">{tag.channel}</Badge> : null}
                    {tag.immutable ? (
                      <Lock className="ver-chip__mark" aria-label="Immutable" role="img" />
                    ) : null}
                    {tag.protected ? (
                      <Badge variant="outline" title="Protected: only tenant admins can move or delete">
                        <Shield aria-hidden />
                        protected
                      </Badge>
                    ) : null}
                  </span>
                  {canProtect ? (
                    <Button
                      variant="ghost"
                      size="sm"
                      disabled={!gitlike.enabled}
                      onClick={() => onToggleTagProtection(tag.id, !tag.protected)}
                    >
                      {tag.protected ? 'Unprotect' : 'Protect'}
                    </Button>
                  ) : null}
                  {canRemove ? (
                    <Button
                      variant="ghost"
                      size="sm"
                      className="ver-gitlike__remove"
                      disabled={!gitlike.enabled}
                      onClick={() => onDeleteTag(tag.id)}
                    >
                      Remove
                    </Button>
                  ) : null}
                </span>
              );
            })}
          </div>
        ) : null}

        {branches.length > 0 ? (
          <div className="ver-gitlike__group" id="ade-named-branches-panel" data-testid="versions-branches-panel">
            <span className="ver-gitlike__label">
              <GitBranch aria-hidden />
              Named branches
            </span>
            {gitlike.marked ? <GitlikeFlag enabled={gitlike.enabled} /> : null}
            {branches.map((branch) => {
              const canRemove =
                (effectiveIsAdmin || (!branch.protected && branch.created_by === currentUserId)) &&
                !isVersionBranchNonDeletable(branch);
              return (
                <span key={branch.id} className="ver-gitlike__chip-set">
                  <span className={cn('ver-chip', branch.is_default && 'is-active')}>
                    <GitBranch aria-hidden />
                    <span className="mono">{branch.name}</span> → v{branch.tip_version_string ?? '?'}
                    {branch.is_default ? (
                      <Badge
                        variant="outline"
                        className="ver-chip__badge"
                        title="Default branch for this project — cannot be deleted"
                      >
                        default
                      </Badge>
                    ) : null}
                    {branch.protected ? (
                      <Badge variant="outline" title="Protected branch: only tenant admins can delete">
                        <Shield aria-hidden />
                        protected
                      </Badge>
                    ) : null}
                  </span>
                  {effectiveIsAdmin ? (
                    <Button
                      variant="ghost"
                      size="sm"
                      disabled={!gitlike.enabled}
                      onClick={() => onToggleBranchProtection(branch.id, !branch.protected)}
                    >
                      {branch.protected ? 'Unprotect' : 'Protect'}
                    </Button>
                  ) : null}
                  {canRemove ? (
                    <Button
                      variant="ghost"
                      size="sm"
                      className="ver-gitlike__remove"
                      disabled={!gitlike.enabled}
                      onClick={() => onDeleteBranch(branch.id)}
                    >
                      Remove
                    </Button>
                  ) : null}
                </span>
              );
            })}
          </div>
        ) : null}
      </div>
      <p className="ver-gitlike__note">
        {tags.length > 0 ? (
          <>
            Tags are stable names for a schema revision (like Git tags). Use &quot;Tag this
            revision&quot; on a version row to add one. Immutable tags cannot be moved or deleted;{' '}
            <span className="ver-gitlike__em">protected</span> tags (tenant admin) add policy so only
            admins can move or delete.{' '}
          </>
        ) : null}
        {branches.length > 0 ? (
          <>
            <span className="ver-gitlike__em">Branch vs fork:</span> a named branch stays in this
            project (same version line). A <span className="ver-gitlike__em">fork</span> copies a
            revision into a <em>different</em> project for isolated experiments; lineage is stored
            for audit and merge-back.
          </>
        ) : null}
      </p>
    </Card>
  );
}
