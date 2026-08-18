'use client';

/**
 * The registry tab's right rail (HIVE-6.5, #5316).
 *
 * Authority: `docs/mockups/build/primitives.html` §Registry → *Right rail* — the relative
 * `$ref` explainer with its worked example, and the last eight imports.
 *
 * ### What this replaces
 *
 * `PrimitivesRecentActivity`, which drew both panels as `dashboardPanelClass` divs and painted
 * the code sample by hand: `bg-gray-900 dark:bg-black/40` behind `text-gray-300`,
 * `text-emerald-300` and `text-indigo-300` spans, and three `bg-*-400` dots chosen in a helper
 * that returned Tailwind palette classes. None of those could follow a theme; the sample was
 * literally a dark box in Whiteboard.
 *
 * The example is data now ({@link REF_RESOLUTION_EXAMPLE}) rather than four hand-written lines
 * with `<br />` between them, so what is a comment and what is code is a property of the line
 * rather than of the markup around it.
 */

import * as React from 'react';
import { Activity, Waypoints } from 'lucide-react';

import { Button } from '@/app/components/ui/Button';
import { Card, CardHeader, CardTitle } from '@/app/components/ui/Card';
import { STATUS_TONE_DOT_CLASS } from '@/app/components/ui/statusVocabulary';
import { cn } from '@lib/utils';
import {
  formatRelativeTime,
  sourceKindLabel,
  type PrimitiveImportActivity,
} from '@/app/ade/dashboard/primitives/primitivesRegistryTypes';

import {
  REF_RESOLUTION_EXAMPLE,
  importActivityTitle,
  importActivityTone,
} from './primitivesModel';

export interface RegistryRailProps {
  /** The last few imports, newest first. */
  imports: readonly PrimitiveImportActivity[];
  /** True while the registry overview is being read. */
  loading: boolean;
  /** Switch the screen to the Resolver tab. */
  onOpenResolver: () => void;
}

/**
 * Render the rail. See {@link RegistryRailProps}.
 *
 * @returns The `$ref` explainer card and the recent-activity card, stacked.
 */
export default function RegistryRail({ imports, loading, onOpenResolver }: RegistryRailProps) {
  return (
    <aside className="prm-rail" aria-label="Registry reference">
      <Card className="prm-rail__card">
        <div className="prm-rail__head">
          <Waypoints aria-hidden />
          <span>
            Relative <span className="mono">$ref</span> resolution
          </span>
        </div>
        <p className="prm-rail__desc">
          References resolve against the type’s import-source base URL in the API server.
        </p>
        <pre className="prm-code" data-testid="primitives-ref-example">
          {REF_RESOLUTION_EXAMPLE.map((line) => (
            <span
              key={line.text}
              className={line.comment ? 'prm-code__comment' : undefined}
              data-comment={line.comment ? 'true' : undefined}
            >
              {line.text}
            </span>
          ))}
        </pre>
        <Button
          variant="link"
          size="sm"
          className="prm-rail__link"
          onClick={onOpenResolver}
          data-testid="primitives-open-resolver-rail"
        >
          Open reference resolver →
        </Button>
      </Card>

      <Card className="prm-rail__card prm-rail__card--flush">
        <CardHeader className="prm-rail__activity-head">
          <CardTitle className="prm-rail__title">
            <Activity aria-hidden />
            Recent activity
          </CardTitle>
          <span className="prm-rail__aside">last 8 imports</span>
        </CardHeader>

        {loading ? (
          <p className="prm-rail__state" role="status">
            Loading activity…
          </p>
        ) : imports.length === 0 ? (
          <p className="prm-rail__state">No import activity yet.</p>
        ) : (
          <ul className="prm-activity">
            {imports.map((item) => (
              <li key={item.id} className="prm-activity__row">
                <span
                  aria-hidden
                  className={cn(
                    'prm-activity__dot',
                    STATUS_TONE_DOT_CLASS[importActivityTone(item.source_kind)]
                  )}
                />
                <span className="prm-activity__text">
                  <span className="prm-activity__title">{importActivityTitle(item)}</span>
                  <span className="prm-activity__sub">
                    {[
                      sourceKindLabel(item.source_kind),
                      item.target_namespace,
                      item.created_at ? formatRelativeTime(item.created_at) : null,
                    ]
                      .filter(Boolean)
                      .join(' · ')}
                  </span>
                </span>
              </li>
            ))}
          </ul>
        )}
      </Card>
    </aside>
  );
}
