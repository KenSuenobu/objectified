'use client';

/**
 * The Schedule sunset (EOL) dialog (HIVE-6.2, #5313).
 *
 * Authority: `docs/mockups/build/versions.html` §Schedule sunset — the revision (read only),
 * lifecycle with *A sunset date requires Deprecated*, the deprecation message, the required
 * sunset date-time (local → UTC) and the successor picker; the sunset-timeline link in the
 * description.
 *
 * The state and the save are the screen's (`handleSunsetScheduleSubmit`); this owns the shape.
 */

import * as React from 'react';
import Link from 'next/link';
import { Sunset } from 'lucide-react';

import { Alert } from '@/app/components/ui/Alert';
import { Button } from '@/app/components/ui/Button';
import { Dialog, DialogContent, DialogFooter } from '@/app/components/ui/Dialog';
import { FormField } from '@/app/components/ui/FormField';
import { Input } from '@/app/components/ui/Input';
import { Textarea } from '@/app/components/ui/Textarea';

import { LifecycleSelect, SuccessorRevisionField, VersionDialogHead } from './VersionDialogChrome';
import { SUNSET_TIMELINE_ROUTE } from './VersionsBanners';
import { versionLabel, type Version } from './versionsModel';

export interface SunsetScheduleDialogProps {
  open: boolean;
  /** Called with `false` to close. The screen refuses while a save is in flight. */
  onOpenChange: (open: boolean) => void;
  /** True while the save is in flight. */
  busy: boolean;
  /** The screen's error line, `''` for none. */
  error: string;
  /** The revision being scheduled, or `null` before one is chosen. */
  version: Version | null;
  /** Published + admin: only deprecation and sunset metadata may change. */
  publishedMetadataOnly: boolean;
  lifecycle: string;
  onLifecycleChange: (next: string) => void;
  deprecationMessage: string;
  onDeprecationMessageChange: (next: string) => void;
  /** The `datetime-local` value, `''` for none. */
  sunsetLocal: string;
  onSunsetLocalChange: (next: string) => void;
  successorRevisionId: string;
  onSuccessorRevisionIdChange: (next: string) => void;
  successorCandidates: readonly Version[];
  onSubmit: () => void;
}

/**
 * Render the dialog. See {@link SunsetScheduleDialogProps}.
 *
 * @returns The dialog.
 */
export default function SunsetScheduleDialog({
  open,
  onOpenChange,
  busy,
  error,
  version,
  publishedMetadataOnly,
  lifecycle,
  onLifecycleChange,
  deprecationMessage,
  onDeprecationMessageChange,
  sunsetLocal,
  onSunsetLocalChange,
  successorRevisionId,
  onSuccessorRevisionIdChange,
  successorCandidates,
  onSubmit,
}: SunsetScheduleDialogProps) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="ver-dialog" data-testid="sunset-schedule-dialog">
        <VersionDialogHead
          icon={<Sunset />}
          tone="warn"
          title="Schedule sunset (EOL)"
          description={
            <>
              Set lifecycle to Deprecated, enter a required sunset date and time (stored in UTC), and
              optionally the successor revision (by version label) consumers should migrate to—or leave
              no successor for a pure end-of-life. Entries appear on the{' '}
              <Link href={SUNSET_TIMELINE_ROUTE} className="ver-link">
                sunset timeline
              </Link>
              .
            </>
          }
        />

        <div className="ver-dialog__body">
          {error ? <Alert variant="error">{error}</Alert> : null}
          {version && publishedMetadataOnly ? (
            <Alert variant="info" data-testid="sunset-schedule-published-note">
              Published revision — only deprecation and sunset metadata can be changed here.
            </Alert>
          ) : null}

          <div className="ver-dialog__grid">
            {version ? (
              <FormField label="Revision" htmlFor="sunset-schedule-revision">
                <Input id="sunset-schedule-revision" className="mono" value={versionLabel(version)} readOnly disabled />
              </FormField>
            ) : null}
            <LifecycleSelect
              id="sunset-schedule-lifecycle"
              value={lifecycle}
              onChange={onLifecycleChange}
              disabled={busy}
              helperText="A sunset date requires Deprecated."
            />
          </div>
          <FormField label="Deprecation message" htmlFor="sunset-schedule-deprecation-msg">
            <Textarea
              id="sunset-schedule-deprecation-msg"
              value={deprecationMessage}
              onChange={(event) => onDeprecationMessageChange(event.target.value)}
              rows={2}
              disabled={busy}
              placeholder="Why this revision is deprecated (optional)"
            />
          </FormField>
          <FormField
            label="Sunset date and time"
            htmlFor="sunset-schedule-local"
            required
            helperText="Required. Local time is converted to UTC for storage. To clear a sunset, use Edit version from the row menu."
          >
            <Input
              id="sunset-schedule-local"
              type="datetime-local"
              value={sunsetLocal}
              onChange={(event) => onSunsetLocalChange(event.target.value)}
              disabled={busy}
              required
              aria-required
              data-testid="sunset-schedule-local"
            />
          </FormField>
          <SuccessorRevisionField
            id="sunset-schedule-successor"
            value={successorRevisionId}
            onChange={onSuccessorRevisionIdChange}
            candidates={successorCandidates}
            disabled={busy}
          />
        </div>

        <DialogFooter className="ver-dialog__footer">
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={busy}>
            Cancel
          </Button>
          <Button onClick={onSubmit} disabled={busy || !sunsetLocal.trim()} data-testid="sunset-schedule-submit">
            {busy ? 'Saving…' : 'Save'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
