'use client';

/**
 * Saved views bar for the lint workspace (CLX-4.1, #4859).
 *
 * Server-persisted per-user views (lint_workspace_saved_views): pinned views render as
 * quick-access chips, and the current filter bundle can be saved under a name. Applying a
 * view rehydrates the page's filter state; management (rename/unpin) stays minimal — chips
 * carry a delete affordance and pins toggle on the chip.
 */

import React, { useState } from 'react';
import { Pin, Plus, X } from 'lucide-react';
import {
  Button,
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  Input,
  Label,
} from '@/app/components/ui';
import type { LintWorkspaceSavedView } from '@/app/utils/lint-workspace';
import { cn } from '@lib/utils';
import { ICON_SIZE } from '@/app/components/ui/iconSizes';

const chipClass =
  'inline-flex items-center gap-1 rounded-full border border-gray-200 bg-white px-2.5 py-1 text-xs font-medium text-gray-700 hover:bg-gray-50 dark:border-gray-700 dark:bg-gray-800 dark:text-gray-200 dark:hover:bg-gray-700';

export interface LintWorkspaceSavedViewsBarProps {
  views: LintWorkspaceSavedView[];
  onApply: (view: LintWorkspaceSavedView) => void;
  onSaveCurrent: (name: string, pin: boolean) => void;
  onTogglePin: (view: LintWorkspaceSavedView) => void;
  onDelete: (view: LintWorkspaceSavedView) => void;
}

/** Pinned-view chips plus the save-current-view dialog. */
export default function LintWorkspaceSavedViewsBar({
  views,
  onApply,
  onSaveCurrent,
  onTogglePin,
  onDelete,
}: LintWorkspaceSavedViewsBarProps) {
  const [saveOpen, setSaveOpen] = useState(false);
  const [name, setName] = useState('');
  const [pin, setPin] = useState(true);

  const submit = () => {
    onSaveCurrent(name.trim(), pin);
    setSaveOpen(false);
    setName('');
    setPin(true);
  };

  return (
    <div data-testid="lint-workspace-saved-views" className="flex flex-wrap items-center gap-2">
      {views.map((view) => (
        <span key={view.id} className={chipClass} data-testid="saved-view-chip">
          <button
            type="button"
            className="hover:underline"
            onClick={() => onApply(view)}
            data-testid="saved-view-apply"
          >
            {view.name}
          </button>
          <button
            type="button"
            title={view.isPinned ? 'Unpin view' : 'Pin view'}
            aria-label={view.isPinned ? `Unpin ${view.name}` : `Pin ${view.name}`}
            onClick={() => onTogglePin(view)}
            data-testid="saved-view-pin"
          >
            <Pin
              size={ICON_SIZE.button}
              className={cn(
                view.isPinned
                  ? 'text-indigo-600 dark:text-indigo-400'
                  : 'text-gray-400 dark:text-gray-500',
              )}
            />
          </button>
          <button
            type="button"
            title="Delete view"
            aria-label={`Delete ${view.name}`}
            onClick={() => onDelete(view)}
            data-testid="saved-view-delete"
          >
            <X size={ICON_SIZE.button} className="text-gray-400 hover:text-rose-500 dark:text-gray-500" />
          </button>
        </span>
      ))}
      <Button
        size="sm"
        variant="outline"
        data-testid="saved-view-save-current"
        onClick={() => setSaveOpen(true)}
      >
        <Plus size={ICON_SIZE.button} />
        Save view
      </Button>

      <Dialog open={saveOpen} onOpenChange={setSaveOpen}>
        <DialogContent data-testid="saved-view-dialog">
          <DialogHeader>
            <DialogTitle>Save current view</DialogTitle>
          </DialogHeader>
          <div className="space-y-3">
            <div className="space-y-1">
              <Label htmlFor="saved-view-name">Name</Label>
              <Input
                id="saved-view-name"
                data-testid="saved-view-name"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="e.g. New security errors"
              />
            </div>
            <label className="flex items-center gap-2 text-sm text-gray-600 dark:text-gray-300">
              <input
                type="checkbox"
                checked={pin}
                onChange={(e) => setPin(e.target.checked)}
                data-testid="saved-view-pin-checkbox"
              />
              Pin to toolbar
            </label>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setSaveOpen(false)}>
              Cancel
            </Button>
            <Button data-testid="saved-view-submit" disabled={!name.trim()} onClick={submit}>
              Save
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
