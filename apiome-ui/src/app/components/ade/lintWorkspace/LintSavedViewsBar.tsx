'use client';

import * as React from 'react';
import { BookmarkPlus, Pin, PinOff, X } from 'lucide-react';

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
import { FormField } from '@/app/components/ui/FormField';
import { Input } from '@/app/components/ui/Input';
import type { LintWorkspaceSavedView, WorkspaceFilters } from '@/app/utils/lint-workspace';
import { filtersToSearchParams } from '@/app/utils/lint-workspace';
import { cn } from '@lib/utils';

import { clearableFilterCount, savedViewMatches } from './lintWorkspaceModel';

/**
 * Saved views — HIVE-5.8 (#5311).
 *
 * Authority: `docs/mockups/govern/lint-posture.html`, the `Views` row and the
 * `#save-view-dialog` overlay.
 *
 * A personal bookmark of the whole address bar: the filters, the sort and the subject scope.
 * The bar re-skins onto the shared chip and button chrome, and adds one thing the screen it
 * replaces could not do — **it says which view you are looking at**. Every chip was
 * identical before, so a reader who had applied "New security errors" and then toggled one
 * facet had no way to see that they were no longer in it. `savedViewMatches` compares the
 * two as the URL codec serialises them, which is the only comparison that cannot disagree
 * with the address bar.
 *
 * The pin and the delete are real buttons inside the chip rather than a menu: there are two
 * of them, they are the whole management surface, and a menu for two items is a click a
 * reader does not need to spend.
 */

/** Props for {@link LintSavedViewsBar}. */
export interface LintSavedViewsBarProps {
  /** The reader's saved views, in the server's order (pinned first). */
  views: readonly LintWorkspaceSavedView[];
  /** The filter state on screen, for marking the chip that matches it. */
  filters: WorkspaceFilters;
  /** The sort on screen. */
  sort: string;
  /** Apply a view. */
  onApply: (view: LintWorkspaceSavedView) => void;
  /** Save what is on screen under a name, optionally pinned. */
  onSaveCurrent: (name: string, pin: boolean) => void;
  /** Pin or unpin a view. */
  onTogglePin: (view: LintWorkspaceSavedView) => void;
  /** Delete a view. */
  onDelete: (view: LintWorkspaceSavedView) => void;
  /** Whether the save dialog is open (the page header's "Save view" opens it too). */
  saveOpen: boolean;
  /** Open or close the save dialog. */
  onSaveOpenChange: (open: boolean) => void;
}

/**
 * The views bar and its save dialog.
 *
 * @param props See {@link LintSavedViewsBarProps}.
 * @returns The chips, the save button and the dialog.
 */
export default function LintSavedViewsBar({
  views,
  filters,
  sort,
  onApply,
  onSaveCurrent,
  onTogglePin,
  onDelete,
  saveOpen,
  onSaveOpenChange,
}: LintSavedViewsBarProps) {
  const [name, setName] = React.useState('');
  const [pin, setPin] = React.useState(true);

  // The dialog's fields are reset when it opens rather than when it closes, so a save that
  // failed leaves the reader's own words on screen to try again with.
  React.useEffect(() => {
    if (saveOpen) {
      setName('');
      setPin(true);
    }
  }, [saveOpen]);

  // The query as the address bar spells it. When nothing is narrowing the queue the string
  // would be a bare `sort=severity`, which reads as a filter and is not one — so the box says
  // in words what is about to be saved instead.
  const narrowed = clearableFilterCount(filters) > 0;
  const query = narrowed
    ? filtersToSearchParams(filters, { sort: sort || 'severity' }).toString()
    : '';
  const trimmed = name.trim();

  const submit = (event: React.FormEvent) => {
    event.preventDefault();
    if (!trimmed) return;
    onSaveCurrent(trimmed, pin);
    onSaveOpenChange(false);
  };

  return (
    <section className="lw-views" aria-label="Saved views" data-testid="lint-workspace-saved-views">
      <h2 className="lw-caps">Views</h2>

      {views.map((view) => {
        const current = savedViewMatches(view, filters, sort);
        return (
          <span
            key={view.id}
            className={cn('lw-view-chip', current && 'is-current')}
            data-testid="saved-view-chip"
            data-current={current || undefined}
          >
            <button
              type="button"
              className="lw-view-chip__apply"
              data-testid="saved-view-apply"
              aria-current={current ? 'true' : undefined}
              onClick={() => onApply(view)}
            >
              {view.isPinned ? <Pin className="lw-view-chip__pinned" aria-hidden /> : null}
              {view.name}
            </button>
            <button
              type="button"
              className="lw-view-chip__action"
              title={view.isPinned ? 'Unpin view' : 'Pin view'}
              aria-label={view.isPinned ? `Unpin ${view.name}` : `Pin ${view.name}`}
              data-testid="saved-view-pin"
              onClick={() => onTogglePin(view)}
            >
              {view.isPinned ? <PinOff aria-hidden /> : <Pin aria-hidden />}
            </button>
            <button
              type="button"
              className="lw-view-chip__action"
              title="Delete view"
              aria-label={`Delete ${view.name}`}
              data-testid="saved-view-delete"
              onClick={() => onDelete(view)}
            >
              <X aria-hidden />
            </button>
          </span>
        );
      })}

      <Button
        variant="outline"
        size="sm"
        data-testid="saved-view-save-current"
        onClick={() => onSaveOpenChange(true)}
      >
        <BookmarkPlus aria-hidden />
        Save view
      </Button>

      <p className="lw-views__note">
        Personal to you · filters, sort and paging are in the URL
      </p>

      <Dialog open={saveOpen} onOpenChange={onSaveOpenChange}>
        <DialogContent size="sm" data-testid="saved-view-dialog">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <span className="tnt-icon-tile" data-tone="accent">
                <BookmarkPlus aria-hidden />
              </span>
              Save current view
            </DialogTitle>
            <DialogDescription>
              Saves the filters, sort and subject scope in the URL as a personal view.
            </DialogDescription>
          </DialogHeader>

          <form className="lw-form" noValidate onSubmit={submit}>
            <FormField label="Name" required>
              <Input
                autoFocus
                value={name}
                data-testid="saved-view-name"
                placeholder="e.g. New security errors"
                onChange={(event) => setName(event.target.value)}
              />
            </FormField>

            <label className="lw-check-row">
              <Checkbox
                checked={pin}
                data-testid="saved-view-pin-checkbox"
                onCheckedChange={(next) => setPin(next === true)}
              />
              Pin to toolbar
            </label>

            {/* What is actually being saved, in the words the address bar uses — so a reader
                can tell two similar views apart before naming the second one. */}
            <p className="lw-query" data-testid="saved-view-query">
              {query || 'No filters — the whole queue, sorted by severity'}
            </p>

            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => onSaveOpenChange(false)}>
                Cancel
              </Button>
              <Button type="submit" data-testid="saved-view-submit" disabled={!trimmed}>
                Save
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </section>
  );
}
