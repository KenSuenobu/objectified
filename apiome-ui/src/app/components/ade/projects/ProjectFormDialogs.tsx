'use client';

/**
 * The create and edit dialogs (HIVE-6.1, #5312).
 *
 * Authority: `docs/mockups/build/projects.html` §"New project" — an `.dialog--xl` with a honey
 * icon tile in its header, two underline tabs (**Create manually** / **Design with AI**, the
 * second carrying a Beta badge), the shared form in the first, the chat panel in the second,
 * and a footer whose left half says "You can change everything later in project settings."
 *
 * The edit dialog is the mockup's note — *"same form minus template + 4 stat tiles"* — so it
 * reuses {@link CreateProjectManualFormFields} and puts the four read-only facts about the
 * project it is editing above it as a `<StatGrid>`.
 *
 * ### What the header used to be
 *
 * A gradient chip: `bg-gradient-to-br from-purple-100 to-indigo-100 dark:from-purple-900/30
 * dark:to-indigo-900/30` around a `text-purple-600` folder, over a title reading "Create New
 * Project" — title case, and a noun phrase where DESIGN.md §10 asks for one that names the
 * thing. The submit button was `bg-gradient-to-r from-purple-500 to-indigo-600`, the only
 * gradient button in the product. Both are the shared primitives now.
 */

import * as React from 'react';
import { Bot, FilePenLine, FolderPlus } from 'lucide-react';

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
import { Stat, StatGrid } from '@/app/components/ui/metrics';
import { TAB_LIST_CLASS, tabTriggerClass } from '@/app/components/ui/tabStyles';
import {
  CreateProjectManualFormFields,
  type CreateProjectManualFormModel,
} from '@/app/components/ade/dashboard/projects/CreateProjectManualFormFields';
import { LLMChatPanel } from '@/app/components/ade/dashboard/LLMImportDialog';

import { PROJECT_LIFECYCLE_LABEL, projectLifecycle, type Project } from './projectsModel';

/** Which half of the create dialog is showing. */
export type CreateProjectTab = 'manual' | 'ai';

/** An absolute instant, as the edit dialog's stat tiles print it. */
function formatStamp(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return date.toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

export interface ProjectCreateDialogProps {
  /** Whether the dialog is open. */
  open: boolean;
  /** Open or dismiss it. */
  onOpenChange: (open: boolean) => void;
  /** Which tab is showing. */
  tab: CreateProjectTab;
  /** Switch tabs. */
  onTabChange: (tab: CreateProjectTab) => void;
  /** The form's current values. */
  model: CreateProjectManualFormModel;
  /** Patch the form. */
  onModelChange: (patch: Partial<CreateProjectManualFormModel>) => void;
  /** Create the project. */
  onSubmit: () => void;
  /** True while the write is in flight. */
  busy?: boolean;
  /** Why the last attempt failed. */
  error?: string | null;
  /** The workspace the project lands in — the AI tab needs it. */
  tenantId?: string;
  /** The signed-in user — the AI tab needs it. */
  userId?: string;
  /** Hand a drafted specification to the import wizard. */
  onImportSpec: (spec: string) => void;
  /** Aborts the AI conversation when the dialog closes. */
  aiPanelRef: React.MutableRefObject<{ abort: () => void } | null>;
}

/**
 * Render the create dialog. See {@link ProjectCreateDialogProps}.
 *
 * @returns The dialog.
 */
export function ProjectCreateDialog({
  open,
  onOpenChange,
  tab,
  onTabChange,
  model,
  onModelChange,
  onSubmit,
  busy = false,
  error = null,
  tenantId,
  userId,
  onImportSpec,
  aiPanelRef,
}: ProjectCreateDialogProps) {
  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        // A dialog dismissed mid-stream must not leave a request writing into a panel that
        // is no longer mounted; the abort is the panel's own, so it can cancel its stream.
        if (!next) aiPanelRef.current?.abort();
        if (!busy) onOpenChange(next);
      }}
    >
      <DialogContent size="xl" className="prj-dialog" data-testid="projects-create-dialog">
        <DialogHeader className="prj-dialog__header">
          <span className="tnt-icon-tile" data-tone="honey">
            <FolderPlus aria-hidden />
          </span>
          <span className="prj-dialog__heading">
            <DialogTitle>New project</DialogTitle>
            <DialogDescription>
              Start from a template, fill in the basics, or describe the API and let AI draft it.
            </DialogDescription>
          </span>
        </DialogHeader>

        <div className={TAB_LIST_CLASS} role="tablist" aria-label="How to create the project">
          <button
            type="button"
            role="tab"
            id="projects-create-tab-manual"
            aria-selected={tab === 'manual'}
            aria-controls="projects-create-panel-manual"
            data-testid="projects-create-tab-manual"
            className={tabTriggerClass({ active: tab === 'manual' })}
            onClick={() => onTabChange('manual')}
          >
            <FilePenLine className="prj-tab-glyph" aria-hidden />
            Create manually
          </button>
          <button
            type="button"
            role="tab"
            id="projects-create-tab-ai"
            aria-selected={tab === 'ai'}
            aria-controls="projects-create-panel-ai"
            data-testid="projects-create-tab-ai"
            className={tabTriggerClass({ active: tab === 'ai' })}
            onClick={() => onTabChange('ai')}
          >
            <Bot className="prj-tab-glyph" aria-hidden />
            Design with AI
            <Badge variant="honey">Beta</Badge>
          </button>
        </div>

        {tab === 'manual' ? (
          <div
            role="tabpanel"
            id="projects-create-panel-manual"
            aria-labelledby="projects-create-tab-manual"
            className="prj-dialog__body"
          >
            <CreateProjectManualFormFields
              fieldIdPrefix="dashboard-projects-create-"
              disabled={busy}
              errorMessage={error}
              model={model}
              onChange={onModelChange}
            />
          </div>
        ) : (
          <div
            role="tabpanel"
            id="projects-create-panel-ai"
            aria-labelledby="projects-create-tab-ai"
            className="prj-dialog__body prj-dialog__body--chat"
          >
            {tenantId && userId ? (
              <LLMChatPanel
                ref={aiPanelRef}
                tenantId={tenantId}
                userId={userId}
                embedded
                className="prj-chat"
                onImportSpec={onImportSpec}
              />
            ) : null}
          </div>
        )}

        <DialogFooter className="prj-dialog__footer">
          <span className="prj-dialog__footnote">
            You can change everything later in project settings.
          </span>
          <Button variant="outline" disabled={busy} onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            disabled={busy || tab === 'ai'}
            onClick={onSubmit}
            data-testid="projects-create-submit"
          >
            {busy ? 'Creating…' : 'Create project'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export interface ProjectEditDialogProps {
  /** The project being edited, or `null` when the dialog is closed. */
  project: Project | null;
  /** Whether the dialog is open. */
  open: boolean;
  /** Open or dismiss it. */
  onOpenChange: (open: boolean) => void;
  /** The form's current values. */
  model: CreateProjectManualFormModel;
  /** Patch the form. */
  onModelChange: (patch: Partial<CreateProjectManualFormModel>) => void;
  /** Save the change. */
  onSubmit: () => void;
  /** True while the write is in flight. */
  busy?: boolean;
  /** Why the last attempt failed. */
  error?: string | null;
}

/**
 * Render the edit dialog. See {@link ProjectEditDialogProps}.
 *
 * The four tiles are read-only facts a reader needs while editing and cannot change from
 * here: what state the project is in, who made it, and when it was created and last touched.
 * A deleted project's Save is refused — undelete it first, which is a different verb with a
 * different confirm.
 *
 * @returns The dialog.
 */
export function ProjectEditDialog({
  project,
  open,
  onOpenChange,
  model,
  onModelChange,
  onSubmit,
  busy = false,
  error = null,
}: ProjectEditDialogProps) {
  const lifecycle = project ? projectLifecycle(project) : 'active';

  return (
    <Dialog open={open} onOpenChange={(next) => !busy && onOpenChange(next)}>
      <DialogContent size="xl" className="prj-dialog" data-testid="projects-edit-dialog">
        <DialogHeader className="prj-dialog__header">
          <span className="tnt-icon-tile" data-tone="accent">
            <FilePenLine aria-hidden />
          </span>
          <span className="prj-dialog__heading">
            <DialogTitle>Edit project</DialogTitle>
            <DialogDescription>
              {project ? project.name : 'Project settings and OpenAPI metadata.'}
            </DialogDescription>
          </span>
        </DialogHeader>

        <div className="prj-dialog__body">
          {project ? (
            <StatGrid columns={4} className="prj-edit-stats">
              <Stat label="Status" value={PROJECT_LIFECYCLE_LABEL[lifecycle]} />
              <Stat
                label="Created by"
                value={project.creator_name}
                footnote={project.creator_email}
              />
              <Stat label="Created" value={formatStamp(project.created_at)} />
              <Stat label="Updated" value={formatStamp(project.updated_at)} />
            </StatGrid>
          ) : null}

          <CreateProjectManualFormFields
            fieldIdPrefix="dashboard-projects-edit-"
            disabled={busy}
            errorMessage={error}
            model={model}
            onChange={onModelChange}
            showStartTemplatePicker={false}
          />
        </div>

        <DialogFooter className="prj-dialog__footer">
          <Button variant="outline" disabled={busy} onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            disabled={busy || lifecycle === 'deleted'}
            title={
              lifecycle === 'deleted' ? 'Undelete this project before editing it' : undefined
            }
            onClick={onSubmit}
            data-testid="projects-edit-submit"
          >
            {busy ? 'Saving…' : 'Save changes'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
