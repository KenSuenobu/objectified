'use client';

/**
 * The repository detail overview (HIVE-7.5, #5322).
 *
 * Authority: `docs/mockups/sources/repository-detail.html` §Preview — the intro sentence,
 * *Recent scans* with its "View scan history →" stub, *Importable mix* with its placeholder
 * split and total, and *Recent imports from this repo* with its "See all →".
 *
 * ### What changed besides the paint
 *
 * The mix list drew four rows: OpenAPI, Arazzo, JSON Schema, and a fourth called "Total
 * importable (row)" carrying the same figure the KPI strip prints two inches above it. Three
 * of those rows are an *estimate* the model splits out of one stored total and the fourth is
 * that total, so the list was silently mixing a measurement with a derivation. The total is
 * the card's footer now — where `ui/Card`'s own footer puts a summary — and the three
 * estimates say so in one line above them rather than in a tooltip on a KPI.
 *
 * The three dots beside the format names were `bg-emerald-500`, `bg-indigo-500` and
 * `bg-purple-500` — three hues invented here, unrelated to the format identity block
 * (`.fmt--*`, HIVE-2.4) that every other surface in the app paints a format with. They are
 * `FormatPill`s now, so OpenAPI is the same colour here as it is in the catalog.
 */

import * as React from 'react';
import { PieChart, Radar, Upload } from 'lucide-react';

import { Button } from '@/app/components/ui/Button';
import { Card, CardContent, CardFooter, CardHeader } from '@/app/components/ui/Card';
import { EmptyState } from '@/app/components/ui/EmptyState';
import { FormatPill } from '@/app/components/ui/catalog/FormatPill';
import { STATUS_TONE_DOT_CLASS } from '@/app/components/ui/statusVocabulary';
import { cn } from '@lib/utils';

import {
  PREVIEW_IMPORTS_SHOWN,
  PREVIEW_INTRO,
  NO_RECENT_SCANS,
  previewImportsFootLabel,
} from './repositoryDetailModel';
import {
  RepositoryImportsTable,
  type RepositoryImportRow,
} from './RepositoryImportsTable';

/** One finished scan, as the repository record carries it. */
export interface RepositoryPreviewScanRow {
  branch: string;
  finished_at: string;
  failed: boolean;
}

/** The three estimated per-kind tallies. */
export interface RepositoryImportableMix {
  openapi: number;
  arazzo: number;
  jsonSchema: number;
}

export interface RepositoryPreviewTabProps {
  /** The repository being previewed. */
  repositoryId: string;
  /** Its recent scans, newest first; an empty list draws the empty state. */
  scans: readonly RepositoryPreviewScanRow[];
  /** The estimated importable split, or `null` when no total has been detected. */
  mix: RepositoryImportableMix | null;
  /** The stored importable total, or `null`. */
  importableTotal: number | null;
  /** Recent imports from this repository. */
  imports: readonly RepositoryImportRow[];
  /** True while the imports read is in flight. */
  importsLoading: boolean;
  /** The imports read's failure, if it failed. */
  importsError: string | null;
  /** Format a scan's timestamp — passed in so the tab needs no clock of its own. */
  formatScanTime: (iso: string, failed: boolean) => string;
  /** "View scan history →", which is a stub until scan jobs are exposed. */
  onViewScanHistory: () => void;
  /** "See all →", which switches to the Imports tab. */
  onSeeAllImports: () => void;
  /** Reference clock for the imports table's relative column. */
  now?: number;
}

/**
 * Render the Preview tab. See {@link RepositoryPreviewTabProps}.
 *
 * @returns The intro line, the scans/mix split, and the recent imports card.
 */
export function RepositoryPreviewTab({
  repositoryId,
  scans,
  mix,
  importableTotal,
  imports,
  importsLoading,
  importsError,
  formatScanTime,
  onViewScanHistory,
  onSeeAllImports,
  now,
}: RepositoryPreviewTabProps) {
  return (
    <div className="flex flex-col gap-6" data-testid="repository-preview-tab">
      <p className="repo-det-note max-w-[72ch]">{PREVIEW_INTRO}</p>

      <div className="repo-det-split">
        <Card data-testid="repository-recent-scans">
          <CardHeader className="repo-det-card__head">
            <h3 className="repo-det-card__title">
              <Radar aria-hidden />
              Recent scans
            </h3>
            <Button
              type="button"
              variant="link"
              size="sm"
              className="repo-det-link"
              onClick={onViewScanHistory}
            >
              View scan history →
            </Button>
          </CardHeader>
          <CardContent>
            {scans.length === 0 ? (
              <EmptyState variant="inline" title={NO_RECENT_SCANS} />
            ) : (
              <div className="repo-det-rows">
                {scans.map((scan) => (
                  <div
                    key={`${scan.branch}:${scan.finished_at}`}
                    className="repo-det-row"
                    data-testid="repository-recent-scan"
                  >
                    {/* The dot is the outcome and the column beside it is the time — the
                        mockup's own split. It carries the word too, because DESIGN.md §6
                        forbids colour as the only signal. */}
                    <span
                      className={cn(
                        'size-2 shrink-0 rounded-full',
                        STATUS_TONE_DOT_CLASS[scan.failed ? 'danger' : 'ok']
                      )}
                      aria-hidden
                    />
                    <span className="sr-only">{scan.failed ? 'Failed' : 'Succeeded'}</span>
                    <span className="mono truncate text-xs">{scan.branch}</span>
                    <span className="repo-det-row__end">
                      {formatScanTime(scan.finished_at, false)}
                    </span>
                  </div>
                ))}
              </div>
            )}
          </CardContent>
        </Card>

        <Card data-testid="repository-importable-mix">
          <CardHeader>
            <h3 className="repo-det-card__title">
              <PieChart aria-hidden />
              Importable mix
            </h3>
          </CardHeader>
          <CardContent className="flex flex-col gap-3">
            <p className="repo-det-note">
              An estimated split of the stored importable total. Real per-kind tallies arrive
              with indexed-path detection.
            </p>
            <div className="repo-det-mix">
              <div className="repo-det-mix__row">
                <FormatPill format="openapi" />
                <span className="repo-det-mix__value mono">
                  {mix != null ? mix.openapi.toLocaleString() : '—'}
                </span>
              </div>
              <div className="repo-det-mix__row">
                <FormatPill format="arazzo" />
                <span className="repo-det-mix__value mono">
                  {mix != null ? mix.arazzo.toLocaleString() : '—'}
                </span>
              </div>
              <div className="repo-det-mix__row">
                <FormatPill format="jsonschema" />
                <span className="repo-det-mix__value mono">
                  {mix != null ? mix.jsonSchema.toLocaleString() : '—'}
                </span>
              </div>
            </div>
          </CardContent>
          <CardFooter>
            <span>Total importable</span>
            <span className="repo-det-mix__value mono">
              {importableTotal != null ? importableTotal.toLocaleString() : '—'}
            </span>
          </CardFooter>
        </Card>
      </div>

      <Card className="overflow-hidden" data-testid="repository-recent-imports">
        <CardHeader className="repo-det-card__head">
          <h3 className="repo-det-card__title">
            <Upload aria-hidden />
            Recent imports from this repo
          </h3>
          <Button
            type="button"
            variant="link"
            size="sm"
            className="repo-det-link"
            onClick={onSeeAllImports}
          >
            See all →
          </Button>
        </CardHeader>
        <RepositoryImportsTable
          repositoryId={repositoryId}
          rows={imports}
          loading={importsLoading}
          error={importsError}
          limit={PREVIEW_IMPORTS_SHOWN}
          emptyCopy="preview"
          now={now}
        />
        <div className="repo-det-table__foot">
          <span>
            {previewImportsFootLabel(
              Math.min(imports.length, PREVIEW_IMPORTS_SHOWN),
              imports.length
            )}
          </span>
        </div>
      </Card>
    </div>
  );
}

export default RepositoryPreviewTab;
