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
import { Badge, badgeVariants } from '../../ui/Badge';
import { cn } from '@lib/utils';
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
  /**
   * Follow the chip to the verdict diff it names (HIVE-7.2, #5319).
   *
   * The chip's tooltip has always ended "Open the Test bench tab for the verdict diff" — and
   * `sources/catalog-item.html` makes it an actual link. Given a handler the badge becomes a
   * button that does what the sentence says; without one it stays the inert chip the project
   * version surface draws.
   */
  onSelect?: () => void;
}

/** Render the chip, or nothing when no suite regressed (or the state is unknown). */
export function SuiteRegressionBadge({
  surface,
  artifact,
  className,
  onSelect,
}: SuiteRegressionBadgeProps) {
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

  const title =
    `${regressedCount} test suite${regressedCount === 1 ? '' : 's'} whose latest run has a ` +
    'previously-passing payload now failing. Open the Test Bench tab for the verdict diff.';
  const label = `Suite regression${regressedCount === 1 ? '' : ` ×${regressedCount}`}`;

  // With a handler the chip *is* the button — the badge's own classes on a `<button>` rather
  // than a button nested inside the chip, so the whole pill is the hit area and there is no
  // interactive element inside another one.
  if (onSelect) {
    return (
      <button
        type="button"
        onClick={onSelect}
        data-testid="suite-regression-badge"
        title={title}
        className={cn(badgeVariants({ variant: 'rose' }), 'cursor-pointer', className)}
      >
        <TrendingDown aria-hidden />
        {label}
      </button>
    );
  }

  return (
    <Badge variant="rose" data-testid="suite-regression-badge" title={title} className={className}>
      <TrendingDown aria-hidden />
      {label}
    </Badge>
  );
}
