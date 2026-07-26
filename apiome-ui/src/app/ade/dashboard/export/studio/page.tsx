'use client';

import { Suspense, useMemo } from 'react';
import { useAuthSession } from '@lib/auth/session-client';
import { useSearchParams } from 'next/navigation';
import Link from 'next/link';
import { PanelsTopLeft } from 'lucide-react';
import { LoadingState } from '../../../../components/ui/LoadingState';
import { Button } from '../../../../components/ui/Button';
import { ExportStudio } from '../../../../components/ade/dashboard/export/ExportStudio';
import type { ExportedArtifactSummary } from '../../../../components/ade/dashboard/export/ExportDialog';
import { recordRecentExport } from '../../../../components/ade/dashboard/export/recentExports';
import { parseExportStudioUrlState } from '../../../../components/ade/dashboard/export/exportStudioUrlState';

/**
 * Export Studio route — `…/ade/dashboard/export/studio` (MFX-41.1, #4348).
 *
 * A tenant-scoped, source-scoped workspace: the full-page twin of the ExportDialog. It reads its
 * scope from the query string (the deep-link contract in `exportStudioLink.ts`, validated by
 * `exportStudioUrlState.ts`) and is never a bare global screen — without a source it shows how to
 * open the Studio from a version or catalog item instead.
 *
 * The link carries the whole session (MFX-41.4): source, target, non-default options, and the step
 * to resume on. Every param is validated before the Studio sees it, and whatever cannot be honoured
 * (unreadable options, credential-shaped keys, an unknown target) arrives as a notice the Studio
 * renders instead of failing.
 */
function ExportStudioRouteContent() {
  const { data: session, status } = useAuthSession();
  const searchParams = useSearchParams();

  // Validate the whole link once per query string: scalars, the compact option overrides
  // (MFX-41.3/41.4), and the resumable step, plus the notices for anything that had to degrade.
  const { state, issues } = useMemo(
    () => parseExportStudioUrlState(searchParams),
    [searchParams],
  );
  const { artifact, version, label, target, origin, sourceFormat, options, step } = state;

  if (status === 'loading') {
    return (
      <main className="p-6">
        <LoadingState minHeightClassName="min-h-[220px]" message="Loading Export Studio…" />
      </main>
    );
  }

  if (!session) {
    return (
      <main className="p-6">
        <p className="text-slate-600 dark:text-slate-400">Sign in to use the Export Studio.</p>
      </main>
    );
  }

  // The Studio is always scoped to a source — never a bare global screen. Without an `artifact`
  // there is nothing to export, so point the user at the entry points that open it scoped.
  if (!artifact) {
    return (
      <main className="mx-auto max-w-3xl p-6">
        <div className="flex gap-4 rounded-xl border border-indigo-200 bg-indigo-50 p-6 dark:border-indigo-800 dark:bg-indigo-950/30">
          <PanelsTopLeft className="h-8 w-8 flex-shrink-0 text-indigo-600 dark:text-indigo-300" aria-hidden />
          <div>
            <h2 className="text-lg font-semibold text-indigo-900 dark:text-indigo-100">
              Open the Export Studio from a source
            </h2>
            <p className="mt-1 text-sm text-indigo-800 dark:text-indigo-200">
              The Studio exports a specific version. Open it from a version’s export dialog (via
              “Open in Export Studio”) or a catalog item, and it will arrive scoped to that source.
            </p>
            <Button asChild className="mt-4">
              <Link href="/ade/dashboard/versions">Go to Versions</Link>
            </Button>
          </div>
        </div>
      </main>
    );
  }

  return (
    <ExportStudio
      artifact={artifact}
      artifactLabel={label}
      version={version}
      initialTarget={target}
      initialOptions={options}
      initialStep={step}
      linkIssues={issues}
      origin={origin}
      sourceFormat={sourceFormat}
      // Record every Studio generate in the MFX-6.5 recent-exports store, keyed by the scoped
      // source — so a catalog item's exports (MFX-41.2) are tracked just as the dialog tracked them.
      onGenerated={(summary: ExportedArtifactSummary) =>
        recordRecentExport(artifact, version || null, summary)
      }
    />
  );
}

export default function ExportStudioPage() {
  // `useSearchParams` needs a Suspense boundary during Next.js static export.
  return (
    <Suspense
      fallback={
        <main className="p-6">
          <LoadingState minHeightClassName="min-h-[220px]" message="Loading Export Studio…" />
        </main>
      }
    >
      <ExportStudioRouteContent />
    </Suspense>
  );
}
