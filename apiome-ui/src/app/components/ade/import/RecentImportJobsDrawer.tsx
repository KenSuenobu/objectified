'use client';

/**
 * The *Recent import jobs* drawer (HIVE-6.4, #5315).
 *
 * Authority: `docs/mockups/build/import-wizard.html` §Overlays — the panel that used to sit on
 * a page becomes a right side-sheet, opened from the wizard's head.
 *
 * This is the ticket's one structural addition to `RecentAsyncJobsPanel`: the job list is
 * *reference* while the wizard is the work, and DESIGN.md §1.6 puts glanceable detail in a
 * drawer rather than a page hop. It matters most on the Import step, where a reader who closed
 * a running job needs somewhere to find it again.
 */

import * as React from 'react';

import {
  Drawer,
  DrawerBody,
  DrawerContent,
  DrawerDescription,
  DrawerHeader,
  DrawerTitle,
} from '@/app/components/ui/Drawer';

import RecentAsyncJobsPanel from '../dashboard/asyncJobs/RecentAsyncJobsPanel';
import { IMPORT_WIZARD_COPY } from './importWizardModel';

export interface RecentImportJobsDrawerProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

/**
 * The sheet.
 *
 * The panel inside keeps its own paging and its own fetch — it is unchanged apart from its skin,
 * so the drawer is genuinely just a place to put it.
 *
 * @param props See {@link RecentImportJobsDrawerProps}.
 * @returns The drawer.
 */
export function RecentImportJobsDrawer({ open, onOpenChange }: RecentImportJobsDrawerProps) {
  return (
    <Drawer open={open} onOpenChange={onOpenChange}>
      <DrawerContent size="lg">
        <DrawerHeader>
          <DrawerTitle>{IMPORT_WIZARD_COPY.jobsDrawerTitle}</DrawerTitle>
          <DrawerDescription>{IMPORT_WIZARD_COPY.jobsDrawerNote}</DrawerDescription>
        </DrawerHeader>
        <DrawerBody>
          <RecentAsyncJobsPanel kind="import" title={IMPORT_WIZARD_COPY.jobsDrawerTitle} />
        </DrawerBody>
      </DrawerContent>
    </Drawer>
  );
}

export default RecentImportJobsDrawer;
