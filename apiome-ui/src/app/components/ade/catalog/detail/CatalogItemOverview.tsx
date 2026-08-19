'use client';

/**
 * The Catalog item detail's **Overview** pane (HIVE-7.2, #5319).
 *
 * Authority: `docs/mockups/sources/catalog-item.html` §Overview — the API-surface tiles and
 * their composition bar on the left, the Quality / Source / Model-observability aside on the
 * right, and the parsed group cards below both.
 *
 * The pane this replaces was ~330 lines inside `CatalogItemDetailClient`, and every colour on
 * it was a named palette string: four hand-written `bg-emerald-100 text-emerald-600
 * dark:bg-emerald-900/40` icon chips, two hand-rolled coverage meters, a hand-rolled score
 * bar, and a `StatusChip` that spelled three tones a fourth way. All of it is tokens and
 * shared primitives now — `Stat`, `Ring`, `Meter`, `Badge`, `Card` — so the pane follows all
 * nine themes and all six font scales without a single `dark:` variant.
 *
 * @see `./catalogItemView.ts` — every figure, label and tone decision on this pane.
 */

import * as React from 'react';
import {
  ArrowRight,
  Braces,
  ClipboardPaste,
  FileUp,
  Globe,
  Info,
  Radar,
  Radio,
  Server,
  Zap,
} from 'lucide-react';

import { Badge } from '@/app/components/ui/Badge';
import { Button } from '@/app/components/ui/Button';
import { Card, CardBody, CardHeader, CardTitle } from '@/app/components/ui/Card';
import { Meter } from '@/app/components/ui/metrics';
import { ringTier } from '@/app/components/ui/metrics/metricTiers';
import { GradeChip } from '@/app/components/ui/catalog/GradeChip';
import {
  CatalogParsedGroups,
  type CatalogParsedGroup,
} from '@/app/components/ade/dashboard/catalog/CatalogParsedModel';
import {
  deriveParsedFieldStats,
  deriveSurfaceComposition,
  deriveTagDistribution,
  type SurfaceKey,
} from '@/app/utils/catalog-detail-insights';
import { cn } from '@lib/utils';

import {
  CATALOG_SURFACE_TILES,
  catalogModelCountLine,
  catalogQualityBand,
  catalogSourceChips,
  catalogSourceHeadline,
  catalogSourceKindView,
  catalogSurfaceCountLine,
  catalogSurfaceTileFoot,
  type CatalogNormalizedSummary,
  type CatalogSourceDescriptor,
} from './catalogItemView';

/**
 * The glyph for each surface tile and each intake kind.
 *
 * A lookup rather than a `switch` in four places: the view model returns a key, this table
 * turns it into a component, and nothing else in the pane knows an icon's name.
 */
const GLYPH: Readonly<Record<string, React.ComponentType<{ className?: string }>>> = {
  services: Server,
  operations: Zap,
  types: Braces,
  channels: Radio,
  file: FileUp,
  url: Globe,
  paste: ClipboardPaste,
  discovery: Radar,
};

/** The tone a chip in the Source snapshot resolves to, in `Badge`'s vocabulary. */
const CHIP_VARIANT = { ok: 'ok', accent: 'accent', neutral: 'neutral' } as const;

export interface CatalogItemOverviewProps {
  /** The normalized-content counts, each `null` until captured. */
  summary: CatalogNormalizedSummary;
  /** The paradigm-tagged parsed entity groups (MFI-25.2); `[]` when unavailable. */
  parsed: CatalogParsedGroup[];
  /** The note under the composition bar, folded from the groups. */
  summaryNote: string | null;
  /** Where the item was imported from. */
  source: CatalogSourceDescriptor | null;
  /** The quality score the header's orb shows, or `null` when nothing was captured. */
  qualityScore: number | null;
  /** Its letter grade, when one was captured. */
  qualityGrade: string | null;
  /** An entity anchor a just-followed lint deep-link is highlighting. */
  highlightedAnchor?: string | null;
  /** Open the Lint & score pane. */
  onOpenLint: () => void;
  /** Open the Source & code pane. */
  onOpenSource: () => void;
}

/**
 * Render the Overview pane. See {@link CatalogItemOverviewProps}.
 *
 * @returns The main/aside grid, followed by the parsed group cards.
 */
export function CatalogItemOverview({
  summary,
  parsed,
  summaryNote,
  source,
  qualityScore,
  qualityGrade,
  highlightedAnchor,
  onOpenLint,
  onOpenSource,
}: CatalogItemOverviewProps) {
  const composition = deriveSurfaceComposition(summary);
  const fieldStats = deriveParsedFieldStats(parsed);
  const tagDistribution = deriveTagDistribution(parsed);
  const countLine = catalogSurfaceCountLine(composition.total);
  const hasAnyCount = CATALOG_SURFACE_TILES.some(
    (tile) => typeof summary[tile.key as SurfaceKey] === 'number',
  );

  return (
    <>
      <div className="cid-overview">
        <div className="cid-overview__main">
          <Card data-testid="catalog-detail-summary">
            <CardHeader>
              <CardTitle>
                <Braces aria-hidden />
                API surface
              </CardTitle>
              {countLine ? <span className="cid-quiet">{countLine}</span> : null}
            </CardHeader>
            <CardBody>
              {hasAnyCount ? (
                <>
                  <div className="cid-tiles">
                    {CATALOG_SURFACE_TILES.map((tile) => {
                      const value = summary[tile.key as SurfaceKey];
                      const segment = composition.segments.find((s) => s.key === tile.key);
                      const percent =
                        typeof value === 'number' && composition.total > 0
                          ? segment?.percent ?? 0
                          : null;
                      const Glyph = GLYPH[tile.icon];
                      return (
                        <div
                          key={tile.key}
                          className="cid-tile"
                          data-testid="catalog-detail-surface-tile"
                        >
                          <span className="cid-tile__label">
                            <Glyph aria-hidden className={`cid-surface-glyph cid-surface-glyph--${tile.tone}`} />
                            {tile.label}
                          </span>
                          <span
                            className={cn('cid-tile__value mono', typeof value !== 'number' && 'cid-tile__value--absent')}
                          >
                            {typeof value === 'number' ? value.toLocaleString() : '—'}
                          </span>
                          <span className="cid-tile__foot">
                            {catalogSurfaceTileFoot(value, percent)}
                          </span>
                        </div>
                      );
                    })}
                  </div>
                  {composition.segments.length > 0 ? (
                    <div className="cid-compbar" data-testid="catalog-detail-surface-bar">
                      {composition.segments.map((segment) => {
                        const tile = CATALOG_SURFACE_TILES.find((t) => t.key === segment.key)!;
                        return (
                          <span
                            key={segment.key}
                            className={`cid-compbar__slice cid-compbar__slice--${tile.tone}`}
                            style={{ width: `${(segment.count / composition.total) * 100}%` }}
                            title={`${tile.label}: ${segment.count} (${segment.percent}%)`}
                          />
                        );
                      })}
                    </div>
                  ) : null}
                </>
              ) : (
                <p className="cid-note">
                  The normalized-content summary has not been captured for this item yet.
                </p>
              )}
              {summaryNote ? (
                <p className="cid-note cid-note--icon" data-testid="catalog-detail-summary-note">
                  <Info aria-hidden />
                  {summaryNote}
                </p>
              ) : null}
            </CardBody>
          </Card>

          {/* The actual normalized model. A lint finding deep-link (MFI-28.2) highlights its
              target entity here. */}
          <CatalogParsedGroups parsed={parsed} highlightedAnchor={highlightedAnchor} />
        </div>

        <aside className="cid-overview__aside">
          <Card className="cid-panel" data-testid="catalog-detail-quality-snapshot">
            <div className="cid-panel__head">
              <h2 className="cid-panel__title">Quality snapshot</h2>
              <Button
                variant="link"
                size="sm"
                className="cid-panel__link"
                onClick={onOpenLint}
                data-testid="catalog-detail-open-lint"
              >
                Open Lint &amp; score
                <ArrowRight aria-hidden />
              </Button>
            </div>
            {qualityScore != null ? (
              <>
                <div className="cid-score">
                  {/* The mockup's `badge--lg badge--sq badge--mono` letter is `GradeChip`, which
                      the list's rows and the lint report already draw, so one B is one green. */}
                  <GradeChip grade={qualityGrade ?? undefined} className="cid-score__grade" />
                  <div>
                    <p className="cid-score__value mono">
                      {qualityScore}
                      <span className="cid-score__max"> /100</span>
                    </p>
                    <p className="cid-quiet">{catalogQualityBand(qualityScore)?.band}</p>
                  </div>
                </div>
                <Meter
                  className="mt-3"
                  label="Quality score"
                  value={qualityScore}
                  tone={ringTier(qualityScore).tone}
                  showValue={false}
                  warnAt={null}
                />
                <p className="cid-note">{catalogQualityBand(qualityScore)?.detail}</p>
              </>
            ) : (
              <p className="cid-note">No quality score has been captured for this item yet.</p>
            )}
          </Card>

          <Card className="cid-panel" data-testid="catalog-detail-source-snapshot">
            <div className="cid-panel__head">
              <h2 className="cid-panel__title">Source snapshot</h2>
              <Button
                variant="link"
                size="sm"
                className="cid-panel__link"
                onClick={onOpenSource}
                data-testid="catalog-detail-open-source"
              >
                View source
                <ArrowRight aria-hidden />
              </Button>
            </div>
            <div className="cid-source">
              <span className="tnt-icon-tile" data-tone="accent" aria-hidden>
                {React.createElement(GLYPH[catalogSourceKindView(source?.kind ?? null).icon])}
              </span>
              <div className="min-w-0">
                <p
                  className="cid-source__name mono"
                  title={source?.label || source?.uri || undefined}
                >
                  {catalogSourceHeadline(source)}
                </p>
                <p className="cid-quiet">{catalogSourceKindView(source?.kind ?? null).label}</p>
              </div>
            </div>
            <div className="cid-chips">
              {catalogSourceChips(source).map((chip) => (
                <Badge
                  key={chip.label}
                  variant={CHIP_VARIANT[chip.tone]}
                  title={chip.title}
                  className={chip.uri ? 'cid-chip--uri' : undefined}
                >
                  {chip.label}
                </Badge>
              ))}
            </div>
          </Card>

          {parsed.length > 0 ? (
            <Card className="cid-panel" data-testid="catalog-detail-insights">
              <div className="cid-panel__head">
                <h2 className="cid-panel__title">Model observability</h2>
                <span className="cid-quiet mono">
                  {catalogModelCountLine(fieldStats.entityCount, fieldStats.fieldCount)}
                </span>
              </div>
              <div className="cid-coverage" data-testid="catalog-detail-docs-coverage">
                <div className="cid-coverage__head">
                  <span>Documented fields</span>
                  <span className="mono">
                    {fieldStats.documentedFieldCount} / {fieldStats.fieldCount}
                  </span>
                </div>
                <Meter
                  label="Documented fields"
                  value={fieldStats.documentedFieldCount}
                  max={Math.max(fieldStats.fieldCount, 1)}
                  tone={ringTier(fieldStats.documentedPercent ?? 0).tone}
                  valueLabel={
                    fieldStats.documentedPercent !== null ? `${fieldStats.documentedPercent}%` : '—'
                  }
                  warnAt={null}
                />
                <p className="cid-micro">carry a description</p>
              </div>
              <div className="cid-coverage" data-testid="catalog-detail-required-coverage">
                <div className="cid-coverage__head">
                  <span>Required fields</span>
                  <span className="mono">
                    {fieldStats.requiredFieldCount} / {fieldStats.fieldCount}
                  </span>
                </div>
                <Meter
                  label="Required fields"
                  value={fieldStats.requiredFieldCount}
                  max={Math.max(fieldStats.fieldCount, 1)}
                  tone="accent"
                  valueLabel={
                    fieldStats.requiredPercent !== null ? `${fieldStats.requiredPercent}%` : '—'
                  }
                  warnAt={null}
                />
                <p className="cid-micro">are required</p>
              </div>
              {tagDistribution.length > 0 ? (
                <>
                  <h3 className="cid-caps">Entity kinds</h3>
                  <div className="cid-chips" data-testid="catalog-detail-kind-mix">
                    {tagDistribution.map((row) => (
                      <Badge key={row.tag} variant="neutral" mono>
                        {row.tag} {row.count} · {row.percent}%
                      </Badge>
                    ))}
                  </div>
                </>
              ) : null}
            </Card>
          ) : null}
        </aside>
      </div>
    </>
  );
}
