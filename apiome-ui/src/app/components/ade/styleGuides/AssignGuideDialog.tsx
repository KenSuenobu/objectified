'use client';

import * as React from 'react';
import { BadgeCheck, Plus, X } from 'lucide-react';

import { Alert } from '@/app/components/ui/Alert';
import { Avatar } from '@/app/components/ui/Avatar';
import { Badge } from '@/app/components/ui/Badge';
import { Button } from '@/app/components/ui/Button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/app/components/ui/Dialog';
import { Label } from '@/app/components/ui/Label';

import type { StyleGuide } from './styleGuidesModel';

/**
 * Assign a style guide — HIVE-5.6 (#5309).
 *
 * Authority: `docs/mockups/govern/style-guides.html` `#assign-dialog`; DESIGN.md §7.
 *
 * The two ways `resolve_style_guide` (GOV-1.4) can pick a guide, in the order it consults
 * them: a **project** pin wins over the **tenant default**. The dialog states that in its
 * description because it is the only thing a reader needs to know to predict which guide a
 * lint run will use, and the screen this replaces did not say it anywhere.
 *
 * ### Every write here is immediate
 *
 * Making a guide the default, pinning a project and unpinning one are three separate PUT/
 * DELETE calls that take effect as they are pressed — there is no draft and no Save. The
 * footer's button is therefore **Done**, not Cancel: there is nothing to cancel, and a
 * Cancel that discarded nothing would be a lie about what just happened.
 */

/** A project the guide can be pinned to. */
export interface AssignableProject {
  /** The project's id. */
  id: string;
  /** Its display name. */
  name: string;
}

/** Props for {@link AssignGuideDialog}. */
export interface AssignGuideDialogProps {
  /** Whether the dialog is open. */
  open: boolean;
  /** Close it. */
  onOpenChange: (open: boolean) => void;
  /** The guide being assigned; `null` while closed. */
  guide: StyleGuide | null;
  /** Every project of the tenant. */
  projects: readonly AssignableProject[];
  /** True while one of the three writes is in flight. */
  busy?: boolean;
  /** Why the last write failed, if it did. */
  error?: string | null;
  /** Make this guide the tenant default. */
  onMakeDefault: (guide: StyleGuide) => void;
  /** Pin this guide to a project. */
  onAssignProject: (guide: StyleGuide, projectId: string) => void;
  /** Remove a project's pin, whichever guide it points at. */
  onUnassignProject: (projectId: string) => void;
}

/**
 * The assign dialog.
 *
 * @param props See {@link AssignGuideDialogProps}.
 * @returns The dialog.
 */
export default function AssignGuideDialog({
  open,
  onOpenChange,
  guide,
  projects,
  busy = false,
  error = null,
  onMakeDefault,
  onAssignProject,
  onUnassignProject,
}: AssignGuideDialogProps) {
  const [projectId, setProjectId] = React.useState('');

  React.useEffect(() => {
    if (open) setProjectId('');
  }, [open, guide?.id]);

  // Projects already pinned to *this* guide are not offered again. One that points at
  // another guide is offered, and assigning it simply moves the pin — the REST layer
  // replaces the row rather than refusing.
  const assigned = React.useMemo(
    () => new Set((guide?.projectAssignments ?? []).map((a) => a.projectId)),
    [guide]
  );
  const options = projects.filter((project) => !assigned.has(project.id));

  return (
    <Dialog open={open} onOpenChange={(next) => !busy && onOpenChange(next)}>
      <DialogContent data-testid="style-guide-assign-dialog">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <span className="tnt-icon-tile" data-tone="ok">
              <BadgeCheck aria-hidden />
            </span>
            Assign “{guide?.name}”
          </DialogTitle>
          <DialogDescription>
            Assignments take effect on the next lint run: a project-level assignment wins over
            the tenant default.
          </DialogDescription>
        </DialogHeader>

        <div className="sg-assign-body">
          {error && (
            <Alert variant="error" data-testid="style-guide-assign-error">
              {error}
            </Alert>
          )}

          <section>
            <h3 className="sg-section-title">Tenant default</h3>
            <p className="sg-section-desc">Applies to every project without its own assignment.</p>
            <div className="sg-default-row">
              {guide?.isDefault ? (
                <Badge variant="ok" size="lg" data-testid="style-guide-is-default">
                  <BadgeCheck aria-hidden />
                  This guide is the tenant default
                </Badge>
              ) : (
                <Button
                  variant="outline"
                  size="sm"
                  disabled={busy || !guide}
                  data-testid="style-guide-make-default"
                  onClick={() => guide && onMakeDefault(guide)}
                >
                  Make tenant default
                </Button>
              )}
            </div>
          </section>

          <section>
            <h3 className="sg-section-title">Project assignments</h3>
            <p className="sg-section-desc">
              Pin this guide to individual projects, overriding the tenant default.
            </p>
            <div className="sg-assign-picker">
              <Label htmlFor="style-guide-project" className="sr-only">
                Project to assign
              </Label>
              <select
                id="style-guide-project"
                aria-label="Project to assign"
                className="hive-control sg-select sg-assign-picker__select"
                value={projectId}
                disabled={busy || options.length === 0}
                onChange={(event) => setProjectId(event.target.value)}
              >
                <option value="">
                  {options.length === 0 ? 'Every project is already pinned' : 'Select a project…'}
                </option>
                {options.map((project) => (
                  <option key={project.id} value={project.id}>
                    {project.name}
                  </option>
                ))}
              </select>
              <Button
                disabled={busy || !projectId || !guide}
                data-testid="style-guide-assign-project"
                onClick={() => {
                  if (!guide || !projectId) return;
                  onAssignProject(guide, projectId);
                  setProjectId('');
                }}
              >
                <Plus aria-hidden />
                Assign
              </Button>
            </div>

            {(guide?.projectAssignments.length ?? 0) > 0 ? (
              <ul className="sg-assign-list" data-testid="style-guide-assignments">
                {guide?.projectAssignments.map((assignment) => (
                  <li key={assignment.projectId} className="sg-assign-row">
                    <Avatar
                      name={assignment.projectName}
                      seed={assignment.projectId}
                      size="xs"
                      shape="hex"
                      aria-hidden
                    />
                    <span className="sg-assign-row__name">{assignment.projectName}</span>
                    <code className="sg-assign-row__id mono">{assignment.projectId}</code>
                    <Button
                      variant="ghost"
                      size="sm"
                      className="sg-assign-row__remove px-1.5"
                      disabled={busy}
                      title="Unassign"
                      aria-label={`Unassign ${assignment.projectName}`}
                      onClick={() => onUnassignProject(assignment.projectId)}
                    >
                      <X aria-hidden />
                    </Button>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="sg-quiet">No projects assigned to this guide.</p>
            )}
          </section>
        </div>

        <DialogFooter>
          <Button disabled={busy} onClick={() => onOpenChange(false)}>
            Done
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
