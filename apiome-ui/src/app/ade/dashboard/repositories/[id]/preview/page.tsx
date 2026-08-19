'use client';

import { Suspense } from 'react';
import { Page, PageBody } from '@/app/components/shell/pageChrome';
import { LoadingState } from '@/app/components/ui/LoadingState';
import { REPOSITORY_LOADING } from '@/app/components/ade/repositories';
import { RepositoryDetailClient } from '../RepositoryDetailClient';

/**
 * The repository detail route (HIVE-7.5, #5322).
 *
 * The client reads `useSearchParams` for its tab and its file deep link, so it has to sit under
 * a `Suspense` boundary; the fallback is the same page frame the client renders into, so the
 * shell does not jump when the boundary resolves.
 */
export default function RepositoryPreviewPage() {
  return (
    <Suspense
      fallback={
        <Page>
          <PageBody>
            <LoadingState className="min-h-[40vh]" message={REPOSITORY_LOADING} />
          </PageBody>
        </Page>
      }
    >
      <RepositoryDetailClient />
    </Suspense>
  );
}
