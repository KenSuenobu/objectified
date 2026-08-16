'use client';

/**
 * SuiteRegressionBadge (IXH-5.7, #5119).
 *
 * The regression indicator the catalog item and project version detail surfaces carry: a chip
 * that appears only when at least one of the artifact's saved test suites has a **newest run
 * flagging a regression** — a payload that passed in the previous run and fails now. Modeled
 * on `VersionLintBadge`: fetches lazily, renders nothing while loading, on fetch failure, or
 * when there is nothing to warn about, so the surfaces carry no dead chrome.
 */

import { useEffect, useState } from 'react';
import { TrendingDown } from 'lucide-react';
import type { BenchSurface } from '@/app/utils/schema-test-bench';
import {
  countRegressedSuites,
  suiteRefForSurface,
  type SchemaTestSuite,
} from '@/app/utils/schema-test-suites';

export interface SuiteRegressionBadgeProps {
  /** Which detail surface hosts the badge (`catalog` | `project`). */
  surface: BenchSurface;
  /** Artifact slug (preferred) or id. */
  artifact: string;
  /** Extra classes for placement on the hosting surface. */
  className?: string;
}

/** Render the chip, or nothing when no suite regressed (or the state is unknown). */
export function SuiteRegressionBadge({ surface, artifact, className }: SuiteRegressionBadgeProps) {
  const [regressedCount, setRegressedCount] = useState(0);

  useEffect(() => {
    let cancelled = false;
    setRegressedCount(0);
    (async () => {
      try {
        const ref = suiteRefForSurface(surface, artifact);
        const res = await fetch(`/api/schemas/suites?ref=${encodeURIComponent(ref)}`);
        const data = await res.json();
        if (cancelled || !res.ok || !data.success) return;
        const suites: SchemaTestSuite[] = Array.isArray(data.items) ? data.items : [];
        setRegressedCount(countRegressedSuites(suites));
      } catch {
        // Silent: the badge is a warning surface, not a health check; absence means "nothing
        // to warn about (or nothing knowable)", never an error state of its own.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [surface, artifact]);

  if (regressedCount === 0) return null;

  return (
    <span
      data-testid="suite-regression-badge"
      title={
        `${regressedCount} test suite${regressedCount === 1 ? '' : 's'} whose latest run has a ` +
        'previously-passing payload now failing. Open the Test Bench tab for the verdict diff.'
      }
      className={`inline-flex items-center gap-1 rounded-full bg-rose-100 px-2 py-0.5 text-2xs font-semibold uppercase tracking-wider text-rose-800 dark:bg-rose-900/50 dark:text-rose-300 ${className ?? ''}`}
    >
      <TrendingDown className="h-3 w-3" aria-hidden />
      Suite regression{regressedCount === 1 ? '' : ` ×${regressedCount}`}
    </span>
  );
}
