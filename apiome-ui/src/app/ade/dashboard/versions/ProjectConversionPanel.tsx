'use client';

/**
 * ProjectConversionPanel (CPDO-3.3, #4803) — the converted-project side of the conversion
 * evidence history.
 *
 * Rendered as a conditional main tab on the versions screen when the selected project was
 * produced by at least one conversion. Lists the provenance rows targeting this project
 * ({@link ConversionHistoryList} in `project` perspective): each row names the target revision
 * its snapshot is linked to (jumping to it via the page's existing version selection) and links
 * back to the source catalog item, whose Conversions tab replays the stored evidence graph.
 */

import { RotateCcw } from 'lucide-react';
import { ConversionHistoryList } from '../../../components/ade/dashboard/catalog/ConversionHistoryList';
import type { ConversionProvenanceRow } from '@/app/utils/conversion-provenance';

export interface ProjectConversionPanelProps {
  /** Provenance rows targeting the selected project, newest first. */
  rows: ConversionProvenanceRow[];
  loading: boolean;
  error: string | null;
  retry: () => void;
  /** Jump the page's version selection to a target revision row id. */
  onSelectVersion?: (versionRecordId: string) => void;
}

export function ProjectConversionPanel({
  rows,
  loading,
  error,
  retry,
  onSelectVersion,
}: ProjectConversionPanelProps) {
  return (
    <section
      data-testid="project-conversion-panel"
      aria-label="Conversion history"
      className="space-y-4"
    >
      <div>
        <h3 className="text-sm font-semibold text-gray-900 dark:text-gray-100">
          Conversion history
        </h3>
        <p className="mt-1 text-xs text-gray-600 dark:text-gray-300">
          This project was produced by converting a catalog item. Each entry links a revision of
          this project to the conversion that created it.
        </p>
      </div>

      {error ? (
        <div
          data-testid="project-conversion-error"
          role="alert"
          className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-800 dark:border-red-900 dark:bg-red-950/40 dark:text-red-200"
        >
          <p>{error}</p>
          <button
            type="button"
            onClick={retry}
            className="mt-1 inline-flex items-center gap-1 text-xs font-medium underline"
          >
            <RotateCcw className="h-3 w-3" aria-hidden="true" />
            Retry
          </button>
        </div>
      ) : null}

      {!loading && !error ? (
        <ConversionHistoryList
          rows={rows}
          currentSourceHash={null}
          perspective="project"
          onOpenVersion={onSelectVersion}
        />
      ) : null}

      <p className="text-xs text-gray-500 dark:text-gray-400">
        Open the catalog item to replay a conversion&apos;s stored evidence graph.
      </p>
    </section>
  );
}

export default ProjectConversionPanel;
