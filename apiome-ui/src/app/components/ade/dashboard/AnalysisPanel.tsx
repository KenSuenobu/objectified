'use client';

/**
 * The Analyze step (HIVE-6.4, #5315).
 *
 * Authority: `docs/mockups/build/import-wizard.html` §Analysis result — Specification
 * information, Format detection, Feature compatibility, Specification analysis, Quality score
 * with its five category cards, and the Errors / Warnings lists.
 *
 * Every section it had is still here; what changed is that none of them names a colour any
 * more. The panel used to carry a five-entry `categoryAccent` table (indigo, violet, blue,
 * emerald, amber — one hue per category, meaning nothing), four gradient metric tiles, ten
 * tinted status boxes and a gradient-headed dialog. Colour is now spent only where it says
 * something: the score bands (through `ringTier`, the same bands the catalog and the MCP lint
 * report read) and the error/warning severities.
 */

import { useState } from 'react';
import { CheckCircle2, AlertCircle, XCircle, FileCode, AlertTriangle, ChevronRight, Info } from 'lucide-react';
import {
  AnalysisResult,
  QualityIssue,
  QualityScoreCategoryId,
  UnsupportedFeature
} from '../../../utils/openapi-analyzer';
import { getNumericScoreTier, NUMERIC_SCORE_TIER_LEGEND } from '../../../utils/numeric-score-tier';
import { Alert } from '../../../components/ui/Alert';
import { Badge } from '../../../components/ui/Badge';
import { Card } from '../../../components/ui/Card';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '../../../components/ui/Dialog';
import { EmptyState } from '../../../components/ui/EmptyState';
import { Progress } from '../../../components/ui/metrics/Progress';
import { Ring } from '../../../components/ui/metrics/Ring';
import { METRIC_TONE_INK_CLASS, ringTier } from '../../../components/ui/metrics/metricTiers';

interface AnalysisPanelProps {
  fileName: string;
  analysis: AnalysisResult;
}

const CATEGORY_ORDER: QualityScoreCategoryId[] = [
  'designQuality',
  'documentation',
  'apiBestPractices',
  'security',
  'performance'
];

/** Dialog copy — aligns with weighted breakdown (#247) */
const categoryDescriptions: Record<QualityScoreCategoryId, { title: string; description: string }> = {
  designQuality: {
    title: 'Design Quality',
    description:
      'Naming conventions, consistency, and reuse via shared components ($ref). Combines consistency and reusability signals.'
  },
  documentation: {
    title: 'Documentation',
    description:
      'Descriptions, examples, and external documentation links (info.externalDocs and tags on larger APIs).'
  },
  apiBestPractices: {
    title: 'API Best Practices',
    description:
      'OpenAPI metadata, tags, servers, and REST-style operations with documented successful HTTP status codes.'
  },
  security: {
    title: 'Security',
    description:
      'Security schemes, global or operation security, HTTPS, and request body schemas suitable for input validation.'
  },
  performance: {
    title: 'Performance',
    description:
      'Pagination and filtering query parameters on GET operations, and cache-related response headers where applicable.'
  }
};

/** The issue severities, in the shared vocabulary's words. */
const SEVERITY_STATUS: Readonly<Record<string, string>> = {
  high: 'error',
  medium: 'warning',
  low: 'info',
};

/** A section label — 11 px caps, `--fg-muted`, per DESIGN.md §3.2. */
function FieldLabel({ children }: { children: React.ReactNode }) {
  return <span className="imp-tile__label">{children}</span>;
}

export function AnalysisPanel({ fileName, analysis }: AnalysisPanelProps) {
  const [selectedCategory, setSelectedCategory] = useState<QualityScoreCategoryId | null>(null);

  const overallTier = getNumericScoreTier(analysis.qualityScore.overall);
  const overallTone = ringTier(analysis.qualityScore.overall).tone;
  const categories = analysis.qualityScore.categories;

  const getIssuesForCategory = (category: QualityScoreCategoryId): QualityIssue[] => {
    return (analysis.qualityScore.issues || []).filter((issue) => issue.category === category);
  };

  const info = analysis.document?.info;

  return (
    <div className="flex flex-col gap-5">
      <div className="flex items-center gap-2 text-fg">
        <FileCode className="size-[var(--icon-dense)] text-accent" aria-hidden />
        <span className="font-semibold">{fileName}</span>
      </div>

      {info && (
        <Card className="p-[var(--card-pad)]">
          <h3 className="mb-3 text-base font-semibold text-fg">Specification information</h3>
          <div className="flex flex-col gap-3">
            {(info.title || info.version) && (
              <div className="flex flex-wrap items-start justify-between gap-4">
                {info.title && (
                  <div>
                    <FieldLabel>Title</FieldLabel>
                    <div className="mt-1 text-sm font-medium text-fg">{info.title}</div>
                  </div>
                )}
                {info.version && (
                  <div>
                    <FieldLabel>Version</FieldLabel>
                    <div className="mt-1">
                      <Badge variant="accent" mono>
                        {info.version}
                      </Badge>
                    </div>
                  </div>
                )}
              </div>
            )}

            {info.description && (
              <div>
                <FieldLabel>Description</FieldLabel>
                <div className="mt-1 text-sm leading-relaxed text-fg-muted">{info.description}</div>
              </div>
            )}

            <div className="grid gap-4 sm:grid-cols-2">
              {info.contact && (
                <div>
                  <FieldLabel>Contact</FieldLabel>
                  <div className="mt-1 text-sm text-fg-muted">
                    {info.contact.name && <div>{info.contact.name}</div>}
                    {info.contact.email && <div className="text-accent">{info.contact.email}</div>}
                    {info.contact.url && <div className="truncate text-xs">{info.contact.url}</div>}
                  </div>
                </div>
              )}

              {info.license && (
                <div>
                  <FieldLabel>License</FieldLabel>
                  <div className="mt-1 text-sm text-fg-muted">
                    {info.license.name}
                    {info.license.url && <div className="truncate text-xs text-accent">{info.license.url}</div>}
                  </div>
                </div>
              )}
            </div>

            {info.termsOfService && (
              <div>
                <FieldLabel>Terms of service</FieldLabel>
                <div className="mt-1 truncate text-sm text-accent">{info.termsOfService}</div>
              </div>
            )}
          </div>
        </Card>
      )}

      <Card className="p-[var(--card-pad)]">
        <h3 className="mb-3 text-base font-semibold text-fg">Format detection</h3>

        {!analysis.formatSupported && analysis.format !== 'unknown' && (
          <Alert variant="warn" className="mb-4">
            <span className="font-semibold">Format not available for import</span> — the detected
            format {analysis.formatDisplayName} is not yet supported for import. Currently supported
            formats: OpenAPI 3.x, Swagger 2.x, JSON Schema, Arazzo, RAML, AsyncAPI, GraphQL,
            Protobuf, Thrift, Avro, and Postman.
          </Alert>
        )}

        <div className="imp-tiles">
          <div className="imp-tile">
            <div className="imp-tile__label">Format</div>
            <div className="imp-tile__value">
              {analysis.formatSupported ? (
                <CheckCircle2 className="text-ok" aria-hidden />
              ) : (
                <AlertTriangle className="text-warn" aria-hidden />
              )}
              <span>{analysis.formatDisplayName}</span>
            </div>
            <div className="mt-2">
              <Badge status={analysis.formatSupported ? 'completed' : 'degraded'}>
                {analysis.formatSupported ? 'Supported' : 'Not supported'}
              </Badge>
            </div>
          </div>

          <div className="imp-tile">
            <div className="imp-tile__label">Syntax</div>
            <div className="imp-tile__value">
              {analysis.syntaxValid ? (
                <CheckCircle2 className="text-ok" aria-hidden />
              ) : (
                <XCircle className="text-danger" aria-hidden />
              )}
              <span>{analysis.syntaxValid ? `Valid ${analysis.syntax.toUpperCase()}` : 'Invalid'}</span>
            </div>
          </div>

          <div className="imp-tile">
            <div className="imp-tile__label">Schema</div>
            <div className="imp-tile__value">
              {analysis.schemaValid ? (
                <CheckCircle2 className="text-ok" aria-hidden />
              ) : (
                <XCircle className="text-danger" aria-hidden />
              )}
              <span>{analysis.schemaValid ? 'Valid' : 'Invalid'}</span>
            </div>
          </div>

          <div className="imp-tile">
            <div className="imp-tile__label">Spec version</div>
            <div className="imp-tile__value">
              <span>{analysis.version !== 'unknown' ? analysis.version : 'N/A'}</span>
            </div>
          </div>
        </div>
      </Card>

      {/* Feature compatibility – unsupported features (#573), deprecated constructs (#575) */}
      {analysis.unsupportedFeatures && analysis.unsupportedFeatures.length > 0 && (
        <Card className="p-[var(--card-pad)]">
          <h3 className="mb-2 flex items-center gap-2 text-base font-semibold text-fg">
            <AlertTriangle className="size-[var(--icon-dense)] text-warn" aria-hidden />
            Feature compatibility
          </h3>
          <p className="mb-4 text-sm text-fg-muted">
            The following features in your specification are not or only partially supported by the
            import, or use deprecated constructs. Deprecated items are flagged; others will be
            skipped or simplified during import.
          </p>
          <ul className="flex flex-col gap-2">
            {analysis.unsupportedFeatures.map((feature: UnsupportedFeature) => (
              <li
                key={feature.id}
                className="imp-row"
                data-level={feature.severity === 'warning' ? 'warn' : undefined}
              >
                {feature.severity === 'warning' ? (
                  <AlertTriangle className="mt-0.5 size-[var(--icon-dense)] shrink-0 text-warn" aria-hidden />
                ) : (
                  <Info className="mt-0.5 size-[var(--icon-dense)] shrink-0 text-accent" aria-hidden />
                )}
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2 font-medium text-fg">
                    {feature.label}
                    {feature.id.startsWith('deprecated-') && <Badge status="deprecated">Deprecated</Badge>}
                    {feature.count != null && (
                      <Badge variant="neutral">
                        {feature.count} {feature.count === 1 ? 'use' : 'uses'}
                      </Badge>
                    )}
                  </div>
                  <div className="mt-1 text-sm text-fg-muted">{feature.description}</div>
                  {feature.id === 'custom-extensions' && analysis.metrics.customExtensions.length > 0 && (
                    <div className="mt-2 flex flex-wrap gap-1.5">
                      {[...analysis.metrics.customExtensions].sort().map((ext) => (
                        <Badge key={ext} variant="neutral" mono>
                          {ext}
                        </Badge>
                      ))}
                    </div>
                  )}
                  {feature.path && <div className="mt-1 font-mono text-xs text-fg-muted">{feature.path}</div>}
                </div>
              </li>
            ))}
          </ul>
        </Card>
      )}

      <Card className="p-[var(--card-pad)]">
        <h3 className="mb-3 text-base font-semibold text-fg">Specification analysis</h3>

        <div className="imp-tiles mb-5">
          {[
            { label: 'Schemas', value: analysis.metrics.schemaCount },
            { label: 'Properties', value: analysis.metrics.propertyCount },
            { label: 'References', value: analysis.metrics.referenceCount },
            { label: 'Paths', value: analysis.metrics.pathCount },
          ].map((metric) => (
            <div key={metric.label} className="imp-tile text-center">
              <div className="text-3xl font-bold tabular-nums text-fg">{metric.value}</div>
              <div className="imp-tile__label mt-1">{metric.label}</div>
            </div>
          ))}
        </div>

        <dl className="flex flex-col gap-2 text-sm">
          <div className="flex items-center justify-between gap-3 border-b border-border py-2">
            <dt className="text-fg-muted">External references</dt>
            <dd className="font-medium text-fg">
              {analysis.metrics.externalReferences.length > 0
                ? `${analysis.metrics.externalReferences.length} URLs detected`
                : 'None'}
            </dd>
          </div>
          <div className="flex items-center justify-between gap-3 border-b border-border py-2">
            <dt className="text-fg-muted">Circular references</dt>
            <dd className="flex items-center gap-2 font-medium text-fg">
              {analysis.metrics.circularReferences.length === 0 ? (
                <>
                  <CheckCircle2 className="size-[var(--icon-dense)] text-ok" aria-hidden />
                  None detected
                </>
              ) : (
                <>
                  <AlertCircle className="size-[var(--icon-dense)] text-warn" aria-hidden />
                  {analysis.metrics.circularReferences.length} detected
                </>
              )}
            </dd>
          </div>
          {analysis.metrics.customExtensions.length > 0 && (
            <div className="border-b border-border py-2">
              <div className="mb-1.5 flex items-center justify-between gap-3">
                <dt className="text-fg-muted">Custom extensions (x-)</dt>
                <dd className="font-medium text-fg">{analysis.metrics.customExtensions.length} total</dd>
              </div>
              <dd className="mt-1 flex flex-wrap gap-1.5">
                {[...analysis.metrics.customExtensions].sort().map((ext) => (
                  <Badge key={ext} variant="neutral" mono>
                    {ext}
                  </Badge>
                ))}
              </dd>
            </div>
          )}
          {(analysis.metrics.compositionSchemas.allOf > 0 ||
            analysis.metrics.compositionSchemas.oneOf > 0 ||
            analysis.metrics.compositionSchemas.anyOf > 0) && (
            <div className="flex items-center justify-between gap-3 py-2">
              <dt className="text-fg-muted">Schema composition</dt>
              <dd className="flex flex-wrap items-center gap-2">
                {(['allOf', 'oneOf', 'anyOf'] as const)
                  .filter((key) => analysis.metrics.compositionSchemas[key] > 0)
                  .map((key) => (
                    <Badge key={key} variant="accent" mono>
                      {key}: {analysis.metrics.compositionSchemas[key]}
                    </Badge>
                  ))}
              </dd>
            </div>
          )}
        </dl>
      </Card>

      <Card className="p-[var(--card-pad)]">
        <h3 className="mb-3 text-base font-semibold text-fg">Quality score</h3>

        {/* The headline: one ring, the letter it carries, and what the band means (#248). */}
        <div className="mb-4 flex flex-wrap items-center gap-4 rounded-lg bg-subtle p-5">
          <Ring
            score={analysis.qualityScore.overall}
            grade={analysis.qualityScore.grade}
            display="grade"
            size="lg"
            label="Quality score"
          />
          <div className="min-w-0 flex-1">
            <div className={`text-lg font-semibold ${METRIC_TONE_INK_CLASS[overallTone]}`}>
              {overallTier.shortLabel} — {overallTier.detailLabel}
            </div>
            <div className="text-sm text-fg-muted">
              Based on specification analysis · {overallTier.rangeLabel}
            </div>
          </div>
          <div className="text-right">
            <div className={`text-3xl font-bold tabular-nums ${METRIC_TONE_INK_CLASS[overallTone]}`}>
              {analysis.qualityScore.overall}
            </div>
            <div className="text-xs tabular-nums text-fg-muted">/ 100 pts</div>
          </div>
        </div>

        <p className="mb-4 text-sm text-fg-muted">
          Weighted score by category (Design Quality 30, Documentation 20, API Best Practices 25,
          Security 15, Performance 10).
        </p>

        <div className="mb-5 rounded-md bg-subtle px-3 py-2">
          <div className="imp-tile__label mb-2">Score guide</div>
          <ul className="grid gap-x-4 gap-y-1.5 text-xs text-fg-muted sm:grid-cols-2">
            {NUMERIC_SCORE_TIER_LEGEND.map((row) => {
              const tone = ringTier(row.band === 'poor' ? 0 : row.band === 'fair' ? 60 : row.band === 'good' ? 75 : 95).tone;
              return (
                <li key={row.band} className="flex items-start gap-2">
                  <span
                    className={`mt-1.5 size-2 shrink-0 rounded-full bg-current ${METRIC_TONE_INK_CLASS[tone]}`}
                    aria-hidden
                  />
                  <span>
                    <span className="font-medium tabular-nums text-fg">{row.rangeLabel}:</span>{' '}
                    {row.shortLabel} — {row.detailLabel}
                  </span>
                </li>
              );
            })}
          </ul>
        </div>

        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
          {CATEGORY_ORDER.map((id) => {
            const cat = categories[id];
            const pct = cat.percent;
            const tone = ringTier(pct).tone;
            const issueCount = getIssuesForCategory(id).length;
            return (
              <button
                key={id}
                type="button"
                onClick={() => setSelectedCategory(id)}
                className="group flex flex-col gap-2 rounded-md bg-subtle p-3 text-left transition-shadow hover:shadow-md"
              >
                <div className="flex items-start justify-between gap-2">
                  <span className="imp-tile__label leading-tight">{cat.label}</span>
                  <span className="shrink-0 text-right">
                    <span className={`block text-sm font-bold tabular-nums ${METRIC_TONE_INK_CLASS[tone]}`}>
                      {cat.points}/{cat.maxPoints}
                    </span>
                    <span className="block text-2xs tabular-nums text-fg-muted">{pct}%</span>
                  </span>
                </div>
                <Progress value={pct} tone={tone} thin label={`${cat.label} score`} />
                <span className="flex items-center justify-between gap-2">
                  <span className="line-clamp-2 text-xs text-fg-muted">{cat.description}</span>
                  {issueCount > 0 && (
                    <span className="flex shrink-0 items-center gap-1 text-xs text-accent group-hover:underline">
                      {issueCount} issues <ChevronRight className="size-3" aria-hidden />
                    </span>
                  )}
                </span>
              </button>
            );
          })}
        </div>

        {/* Quality issues detail dialog */}
        <Dialog open={selectedCategory !== null} onOpenChange={(open) => !open && setSelectedCategory(null)}>
          <DialogContent size="lg">
            {selectedCategory && (
              <>
                <DialogHeader>
                  <DialogTitle>{categoryDescriptions[selectedCategory].title}</DialogTitle>
                  <DialogDescription>
                    {categoryDescriptions[selectedCategory].description}
                  </DialogDescription>
                </DialogHeader>

                <div className="max-h-[50vh] overflow-y-auto">
                  {getIssuesForCategory(selectedCategory).length === 0 ? (
                    <EmptyState
                      variant="compact"
                      tone="honey"
                      icon={<CheckCircle2 />}
                      title="No issues found!"
                      description="Your specification meets all requirements for this category."
                    />
                  ) : (
                    <ul className="flex flex-col gap-2">
                      {getIssuesForCategory(selectedCategory).map((issue, index) => (
                        <li key={index} className="rounded-md bg-subtle p-3">
                          <div className="flex items-start gap-2">
                            <AlertCircle
                              className={`mt-0.5 size-[var(--icon-dense)] shrink-0 ${
                                issue.severity === 'high'
                                  ? 'text-danger'
                                  : issue.severity === 'medium'
                                    ? 'text-warn'
                                    : 'text-accent'
                              }`}
                              aria-hidden
                            />
                            <div className="min-w-0 flex-1">
                              <div className="mb-1 flex flex-wrap items-center gap-2">
                                <span className="text-sm font-medium text-fg">{issue.message}</span>
                                <Badge status={SEVERITY_STATUS[issue.severity] ?? 'unknown'}>
                                  {issue.severity}
                                </Badge>
                              </div>
                              <div className="mb-2 text-sm text-fg-muted">{issue.suggestion}</div>
                              <div className="flex flex-wrap items-center gap-2 text-xs">
                                <Badge variant="neutral" mono>
                                  {issue.path}
                                </Badge>
                                {issue.line && <span className="text-fg-muted">Line {issue.line}</span>}
                              </div>
                            </div>
                          </div>
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              </>
            )}
          </DialogContent>
        </Dialog>
      </Card>

      {analysis.errors.length > 0 && (
        <Card variant="flat" className="p-[var(--card-pad)]">
          <h3 className="mb-3 flex items-center gap-2 text-base font-semibold text-fg">
            <XCircle className="size-[var(--icon-dense)] text-danger" aria-hidden />
            Errors ({analysis.errors.length})
          </h3>
          <ul className="flex flex-col gap-2">
            {analysis.errors.map((error, index) => (
              <li key={index} className="imp-row" data-level="error">
                <XCircle className="mt-0.5 size-[var(--icon-dense)] shrink-0 text-danger" aria-hidden />
                <div>
                  <div className="text-sm font-medium text-fg">{error.message}</div>
                  {error.path && <div className="mt-1 font-mono text-xs text-fg-muted">Path: {error.path}</div>}
                </div>
              </li>
            ))}
          </ul>
        </Card>
      )}

      {analysis.warnings.length > 0 && (
        <Card variant="flat" className="p-[var(--card-pad)]">
          <h3 className="mb-3 flex items-center gap-2 text-base font-semibold text-fg">
            <AlertCircle className="size-[var(--icon-dense)] text-warn" aria-hidden />
            Warnings ({analysis.warnings.length})
          </h3>
          <ul className="flex flex-col gap-2">
            {analysis.warnings.slice(0, 5).map((warning, index) => (
              <li key={index} className="imp-row" data-level="warn">
                <AlertCircle className="mt-0.5 size-[var(--icon-dense)] shrink-0 text-warn" aria-hidden />
                <div className="text-sm text-fg">{warning.message}</div>
              </li>
            ))}
            {analysis.warnings.length > 5 && (
              <li className="text-xs italic text-fg-muted">
                + {analysis.warnings.length - 5} more warnings
              </li>
            )}
          </ul>
        </Card>
      )}
    </div>
  );
}
