'use client';

import { Download, FileWarning, Eye } from 'lucide-react';
import { cn } from '@lib/utils';
import { formatByteSize } from './exportArtifactPreview';
import type { ViewerContentPlan } from './exportViewerGuards';

export interface DeferredFilePanelProps {
  /** The file's name/path, named in the copy so the user knows what is being held back. */
  fileName: string;
  /** The plan that deferred it — carries the size and the reason. */
  plan: ViewerContentPlan;
  /** Load it into the viewer (a head slice when {@link ViewerContentPlan.headOnly}). */
  onLoad: () => void;
  /** Download the whole file instead of rendering it; omitted when there is nothing to download. */
  onDownload?: (() => void) | null;
  /** `data-testid` prefix so the two host surfaces expose distinct ids. */
  testIdPrefix: string;
  className?: string;
}

/**
 * The panel shown in place of the editor for a file the viewer is holding back (MFX-43.5, #4365).
 *
 * Nothing is hidden: the file's real size, why it was not rendered, and what loading it will
 * actually show are all stated, next to the two ways forward — open it here (whole, or as an
 * explicitly truncated head for an over-cap file) or download it and read it in a real editor.
 */
export function DeferredFilePanel({
  fileName,
  plan,
  onLoad,
  onDownload,
  testIdPrefix,
  className,
}: DeferredFilePanelProps) {
  const size = formatByteSize(plan.totalBytes);
  const why =
    plan.reason === 'file-cap'
      ? `${fileName} is ${size} — too large to render whole without slowing this screen down.`
      : `${fileName} is ${size}. This bundle's viewer budget was already spent on the files before it, so it loads only when you ask.`;
  const loadLabel = plan.headOnly ? 'Show the beginning' : 'Load into the viewer';

  return (
    <div
      data-testid={`${testIdPrefix}-deferred`}
      data-reason={plan.reason ?? 'none'}
      className={cn(
        'flex min-h-[240px] flex-col items-center justify-center gap-3 rounded-lg border border-dashed border-amber-300 bg-amber-50/60 p-6 text-center dark:border-amber-800 dark:bg-amber-950/20',
        className,
      )}
    >
      <FileWarning className="h-6 w-6 text-amber-500" aria-hidden />
      <p className="max-w-xl text-sm text-amber-900 dark:text-amber-100">{why}</p>
      <div className="flex flex-wrap items-center justify-center gap-2">
        <button
          type="button"
          data-testid={`${testIdPrefix}-load`}
          onClick={onLoad}
          className="inline-flex items-center gap-1 rounded-md border border-amber-300 bg-white px-2.5 py-1 text-xs font-medium text-amber-900 shadow-sm hover:bg-amber-50 dark:border-amber-700 dark:bg-gray-900 dark:text-amber-100 dark:hover:bg-gray-800"
        >
          <Eye className="h-3.5 w-3.5" aria-hidden />
          {loadLabel}
        </button>
        {onDownload && (
          <button
            type="button"
            data-testid={`${testIdPrefix}-deferred-download`}
            onClick={onDownload}
            className="inline-flex items-center gap-1 rounded-md border border-gray-200 bg-white px-2.5 py-1 text-xs font-medium text-gray-700 shadow-sm hover:bg-gray-50 dark:border-gray-600 dark:bg-gray-900 dark:text-gray-200 dark:hover:bg-gray-800"
          >
            <Download className="h-3.5 w-3.5" aria-hidden />
            Download the whole file
          </button>
        )}
      </div>
      {plan.headOnly && (
        <p className="text-[11px] text-amber-700 dark:text-amber-300">
          The viewer will show the beginning of the file only — download it to read all of it.
        </p>
      )}
    </div>
  );
}

export interface TruncatedContentNoticeProps {
  /** The plan behind the rendered content; nothing renders unless it is a `head` slice. */
  plan: ViewerContentPlan;
  /** Download the whole file; omitted when there is nothing to download. */
  onDownload?: (() => void) | null;
  /** `data-testid` prefix so the two host surfaces expose distinct ids. */
  testIdPrefix: string;
  className?: string;
}

/**
 * The banner above a partially-rendered file (MFX-43.5, #4365) — the "truncation is explicit"
 * acceptance criterion. It states the bytes on screen against the bytes that exist, so a user who
 * scrolls to the bottom of the editor never mistakes the cut for the end of the document.
 */
export function TruncatedContentNotice({
  plan,
  onDownload,
  testIdPrefix,
  className,
}: TruncatedContentNoticeProps) {
  if (plan.mode !== 'head') return null;
  return (
    <div
      data-testid={`${testIdPrefix}-truncated`}
      role="status"
      className={cn(
        'flex flex-wrap items-center gap-2 rounded-md border border-amber-300 bg-amber-50 px-2.5 py-1.5 text-xs text-amber-900 dark:border-amber-800 dark:bg-amber-950/40 dark:text-amber-100',
        className,
      )}
    >
      <FileWarning className="h-3.5 w-3.5 shrink-0" aria-hidden />
      <span>
        Showing the first <strong>{formatByteSize(plan.shownBytes)}</strong> of{' '}
        <strong>{formatByteSize(plan.totalBytes)}</strong>. The rest of the file is not in the
        viewer.
      </span>
      {onDownload && (
        <button
          type="button"
          data-testid={`${testIdPrefix}-truncated-download`}
          onClick={onDownload}
          className="ml-auto inline-flex items-center gap-1 rounded-md border border-amber-300 bg-white px-2 py-0.5 font-medium text-amber-900 hover:bg-amber-50 dark:border-amber-700 dark:bg-gray-900 dark:text-amber-100 dark:hover:bg-gray-800"
        >
          <Download className="h-3 w-3" aria-hidden />
          Download the whole file
        </button>
      )}
    </div>
  );
}
