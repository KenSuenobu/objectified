'use client';

import { useState } from 'react';
import { CheckCircle2, AlertCircle, XCircle, FileCode, AlertTriangle, X, ChevronRight, Info } from 'lucide-react';
import * as Progress from '@radix-ui/react-progress';
import * as Dialog from '@radix-ui/react-dialog';
import {
  AnalysisResult,
  QualityIssue,
  QualityScoreCategoryId,
  UnsupportedFeature
} from '../../../utils/openapi-analyzer';
import { getNumericScoreTier, NUMERIC_SCORE_TIER_LEGEND } from '../../../utils/numeric-score-tier';

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

const categoryAccent: Record<QualityScoreCategoryId, { hover: string; issue: string; gradient: string }> = {
  designQuality: {
    hover: 'hover:border-indigo-300 dark:hover:border-indigo-600',
    issue: 'text-indigo-600 dark:text-indigo-400',
    gradient: 'from-indigo-500 to-indigo-600'
  },
  documentation: {
    hover: 'hover:border-violet-300 dark:hover:border-violet-600',
    issue: 'text-violet-600 dark:text-violet-400',
    gradient: 'from-violet-500 to-violet-600'
  },
  apiBestPractices: {
    hover: 'hover:border-blue-300 dark:hover:border-blue-600',
    issue: 'text-blue-600 dark:text-blue-400',
    gradient: 'from-blue-500 to-blue-600'
  },
  security: {
    hover: 'hover:border-emerald-300 dark:hover:border-emerald-600',
    issue: 'text-emerald-600 dark:text-emerald-400',
    gradient: 'from-emerald-500 to-emerald-600'
  },
  performance: {
    hover: 'hover:border-amber-300 dark:hover:border-amber-600',
    issue: 'text-amber-600 dark:text-amber-400',
    gradient: 'from-amber-500 to-amber-600'
  }
};

export function AnalysisPanel({ fileName, analysis }: AnalysisPanelProps) {
  const [selectedCategory, setSelectedCategory] = useState<QualityScoreCategoryId | null>(null);

  const overallTier = getNumericScoreTier(analysis.qualityScore.overall);
  const categories = analysis.qualityScore.categories;

  const getIssuesForCategory = (category: QualityScoreCategoryId): QualityIssue[] => {
    return (analysis.qualityScore.issues || []).filter((issue) => issue.category === category);
  };

  // Get severity color
  const getSeverityColor = (severity: string) => {
    switch (severity) {
      case 'high': return 'text-red-600 dark:text-red-400 bg-red-50 dark:bg-red-900/20';
      case 'medium': return 'text-yellow-600 dark:text-yellow-400 bg-yellow-50 dark:bg-yellow-900/20';
      case 'low': return 'text-blue-600 dark:text-blue-400 bg-blue-50 dark:bg-blue-900/20';
      default: return 'text-gray-600 dark:text-gray-400 bg-gray-50 dark:bg-gray-900/20';
    }
  };

  const getCategoryGradient = (category: QualityScoreCategoryId) =>
    categoryAccent[category]?.gradient ?? 'from-gray-500 to-gray-600';

  return (
    <div className="space-y-6">
      {/* File Name */}
      <div className="flex items-center gap-2 text-gray-900 dark:text-white">
        <FileCode className="h-5 w-5 text-indigo-600 dark:text-indigo-400" />
        <span className="font-semibold">{fileName}</span>
      </div>

      {/* Specification Information */}
      {analysis.document?.info && (
        <div className="bg-white dark:bg-gray-800 rounded-xl border border-gray-200 dark:border-gray-700 p-6">
          <h3 className="text-lg font-semibold text-gray-900 dark:text-white mb-4">
            Specification Information
          </h3>
          <div className="space-y-3">
            {(analysis.document.info.title || analysis.document.info.version) && (
              <div className="flex items-start justify-between gap-4">
                {analysis.document.info.title && (
                  <div>
                    <span className="text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wider">
                      Title
                    </span>
                    <div className="text-sm font-medium text-gray-900 dark:text-white mt-1">
                      {analysis.document.info.title}
                    </div>
                  </div>
                )}
                {analysis.document.info.version && (
                  <div className="text-right">
                    <span className="text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wider">
                      Version
                    </span>
                    <div className="text-sm font-medium text-gray-900 dark:text-white mt-1">
                      <span className="px-2 py-0.5 bg-indigo-100 dark:bg-indigo-900/30 text-indigo-700 dark:text-indigo-300 rounded">
                        {analysis.document.info.version}
                      </span>
                    </div>
                  </div>
                )}
              </div>
            )}

            {analysis.document.info.description && (
              <div>
                <span className="text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wider">
                  Description
                </span>
                <div className="text-sm text-gray-700 dark:text-gray-300 mt-1 leading-relaxed">
                  {analysis.document.info.description}
                </div>
              </div>
            )}

            <div className="grid grid-cols-2 gap-4 pt-2">
              {analysis.document.info.contact && (
                <div>
                  <span className="text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wider">
                    Contact
                  </span>
                  <div className="text-sm text-gray-700 dark:text-gray-300 mt-1">
                    {analysis.document.info.contact.name && (
                      <div>{analysis.document.info.contact.name}</div>
                    )}
                    {analysis.document.info.contact.email && (
                      <div className="text-indigo-600 dark:text-indigo-400">
                        {analysis.document.info.contact.email}
                      </div>
                    )}
                    {analysis.document.info.contact.url && (
                      <div className="text-xs text-gray-500 dark:text-gray-400 truncate">
                        {analysis.document.info.contact.url}
                      </div>
                    )}
                  </div>
                </div>
              )}

              {analysis.document.info.license && (
                <div>
                  <span className="text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wider">
                    License
                  </span>
                  <div className="text-sm text-gray-700 dark:text-gray-300 mt-1">
                    {analysis.document.info.license.name}
                    {analysis.document.info.license.url && (
                      <div className="text-xs text-indigo-600 dark:text-indigo-400 truncate">
                        {analysis.document.info.license.url}
                      </div>
                    )}
                  </div>
                </div>
              )}
            </div>

            {analysis.document.info.termsOfService && (
              <div>
                <span className="text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wider">
                  Terms of Service
                </span>
                <div className="text-sm text-indigo-600 dark:text-indigo-400 mt-1 truncate">
                  {analysis.document.info.termsOfService}
                </div>
              </div>
            )}
          </div>
        </div>
      )}

      {/* Format Detection */}
      <div className="bg-white dark:bg-gray-800 rounded-xl border border-gray-200 dark:border-gray-700 p-6">
        <h3 className="text-lg font-semibold text-gray-900 dark:text-white mb-4">
          Format Detection
        </h3>

        {/* Unsupported Format Warning */}
        {!analysis.formatSupported && analysis.format !== 'unknown' && (
          <div className="mb-4 p-4 rounded-lg bg-amber-50 dark:bg-amber-900/20 border border-amber-200 dark:border-amber-800">
            <div className="flex items-start gap-3">
              <AlertTriangle className="h-5 w-5 text-amber-600 dark:text-amber-400 flex-shrink-0 mt-0.5" />
              <div>
                <div className="font-medium text-amber-900 dark:text-amber-200">
                  Format Not Available for Import
                </div>
                <div className="text-sm text-amber-700 dark:text-amber-300 mt-1">
                  The detected format <span className="font-semibold">{analysis.formatDisplayName}</span> is not yet supported for import.
                  Currently supported formats: OpenAPI 3.x, Swagger 2.x, JSON Schema, Arazzo, RAML, AsyncAPI, GraphQL, Protobuf, Thrift, Avro, and Postman.
                </div>
              </div>
            </div>
          </div>
        )}

        {/* File Metadata Summary */}
        <div className="mb-4 p-4 rounded-lg bg-gray-50 dark:bg-gray-900/30 border border-gray-200 dark:border-gray-700">
          <div className="grid grid-cols-2 gap-4">
            <div>
              <span className="text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wider">
                Detected Format
              </span>
              <div className="text-sm font-semibold text-gray-900 dark:text-white mt-1 flex items-center gap-2">
                {analysis.formatDisplayName}
                {analysis.formatSupported ? (
                  <span className="px-2 py-0.5 text-xs bg-green-100 dark:bg-green-900/30 text-green-700 dark:text-green-300 rounded">
                    Supported
                  </span>
                ) : (
                  <span className="px-2 py-0.5 text-xs bg-amber-100 dark:bg-amber-900/30 text-amber-700 dark:text-amber-300 rounded">
                    Not Supported
                  </span>
                )}
              </div>
            </div>
            <div>
              <span className="text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wider">
                Spec Version
              </span>
              <div className="text-sm font-semibold text-gray-900 dark:text-white mt-1">
                {analysis.version !== 'unknown' ? analysis.version : 'N/A'}
              </div>
            </div>
          </div>
          {analysis.document?.info?.description && (
            <div className="mt-4 pt-4 border-t border-gray-200 dark:border-gray-700">
              <span className="text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wider">
                Description
              </span>
              <div className="text-sm text-gray-700 dark:text-gray-300 mt-1 leading-relaxed">
                {analysis.document.info.description}
              </div>
            </div>
          )}
        </div>

        <div className="grid grid-cols-3 gap-4">
          {/* Format Card */}
          <div className={`rounded-lg p-4 border ${analysis.formatSupported ? 'bg-green-50 dark:bg-green-900/20 border-green-200 dark:border-green-800' : 'bg-amber-50 dark:bg-amber-900/20 border-amber-200 dark:border-amber-800'}`}>
            <div className="flex items-center gap-2 mb-2">
              {analysis.formatSupported ? (
                <CheckCircle2 className="h-5 w-5 text-green-600 dark:text-green-400" />
              ) : (
                <AlertTriangle className="h-5 w-5 text-amber-600 dark:text-amber-400" />
              )}
              <span className="text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wider">
                Format
              </span>
            </div>
            <div className="text-sm font-medium text-gray-900 dark:text-white">
              {analysis.formatDisplayName}
            </div>
          </div>

          {/* Syntax Card */}
          <div className={`rounded-lg p-4 border ${analysis.syntaxValid ? 'bg-green-50 dark:bg-green-900/20 border-green-200 dark:border-green-800' : 'bg-red-50 dark:bg-red-900/20 border-red-200 dark:border-red-800'}`}>
            <div className="flex items-center gap-2 mb-2">
              {analysis.syntaxValid ? (
                <CheckCircle2 className="h-5 w-5 text-green-600 dark:text-green-400" />
              ) : (
                <XCircle className="h-5 w-5 text-red-600 dark:text-red-400" />
              )}
              <span className="text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wider">
                Syntax
              </span>
            </div>
            <div className="text-sm font-medium text-gray-900 dark:text-white">
              Valid {analysis.syntax.toUpperCase()}
            </div>
          </div>

          {/* Schema Card */}
          <div className={`rounded-lg p-4 border ${analysis.schemaValid ? 'bg-green-50 dark:bg-green-900/20 border-green-200 dark:border-green-800' : 'bg-red-50 dark:bg-red-900/20 border-red-200 dark:border-red-800'}`}>
            <div className="flex items-center gap-2 mb-2">
              {analysis.schemaValid ? (
                <CheckCircle2 className="h-5 w-5 text-green-600 dark:text-green-400" />
              ) : (
                <XCircle className="h-5 w-5 text-red-600 dark:text-red-400" />
              )}
              <span className="text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wider">
                Schema
              </span>
            </div>
            <div className="text-sm font-medium text-gray-900 dark:text-white">
              {analysis.schemaValid ? 'Valid' : 'Invalid'}
            </div>
          </div>
        </div>
      </div>

      {/* Feature compatibility – unsupported features (#573), deprecated constructs (#575) */}
      {analysis.unsupportedFeatures && analysis.unsupportedFeatures.length > 0 && (
        <div className="bg-white dark:bg-gray-800 rounded-xl border border-amber-200 dark:border-amber-800 p-6">
          <h3 className="text-lg font-semibold text-gray-900 dark:text-white mb-2 flex items-center gap-2">
            <AlertTriangle className="h-5 w-5 text-amber-600 dark:text-amber-400" />
            Feature compatibility
          </h3>
          <p className="text-sm text-gray-600 dark:text-gray-400 mb-4">
            The following features in your specification are not or only partially supported by the import, or use deprecated constructs. Deprecated items are flagged; others will be skipped or simplified during import.
          </p>
          <ul className="space-y-3">
            {analysis.unsupportedFeatures.map((feature: UnsupportedFeature) => (
              <li
                key={feature.id}
                className={`flex items-start gap-3 p-3 rounded-lg border ${
                  feature.severity === 'warning'
                    ? 'bg-amber-50 dark:bg-amber-900/20 border-amber-200 dark:border-amber-800'
                    : 'bg-gray-50 dark:bg-gray-900/30 border-gray-200 dark:border-gray-700'
                }`}
              >
                {feature.severity === 'warning' ? (
                  <AlertTriangle className="h-5 w-5 text-amber-600 dark:text-amber-400 flex-shrink-0 mt-0.5" />
                ) : (
                  <Info className="h-5 w-5 text-blue-600 dark:text-blue-400 flex-shrink-0 mt-0.5" />
                )}
                <div className="min-w-0 flex-1">
                  <div className="font-medium text-gray-900 dark:text-white flex items-center gap-2 flex-wrap">
                    {feature.label}
                    {feature.id.startsWith('deprecated-') && (
                      <span className="text-xs px-2 py-0.5 rounded-full bg-amber-200 dark:bg-amber-800/50 text-amber-800 dark:text-amber-200">
                        Deprecated
                      </span>
                    )}
                    {feature.count != null && (
                      <span className="text-xs px-2 py-0.5 rounded-full bg-gray-200 dark:bg-gray-700 text-gray-700 dark:text-gray-300">
                        {feature.count} {feature.count === 1 ? 'use' : 'uses'}
                      </span>
                    )}
                  </div>
                  <div className="text-sm text-gray-600 dark:text-gray-400 mt-1">
                    {feature.description}
                  </div>
                  {feature.id === 'custom-extensions' && analysis.metrics.customExtensions.length > 0 && (
                    <div className="mt-2 flex flex-wrap gap-1.5">
                      {[...analysis.metrics.customExtensions].sort().map((ext) => (
                        <span
                          key={ext}
                          className="inline-flex items-center px-2 py-0.5 rounded text-xs font-mono bg-gray-200 dark:bg-gray-600 text-gray-800 dark:text-gray-200"
                        >
                          {ext}
                        </span>
                      ))}
                    </div>
                  )}
                  {feature.path && (
                    <div className="text-xs text-gray-500 dark:text-gray-500 mt-1 font-mono">
                      {feature.path}
                    </div>
                  )}
                </div>
              </li>
            ))}
          </ul>
        </div>
      )}

      {/* Specification Analysis */}
      <div className="bg-white dark:bg-gray-800 rounded-xl border border-gray-200 dark:border-gray-700 p-6">
        <h3 className="text-lg font-semibold text-gray-900 dark:text-white mb-4">
          Specification Analysis
        </h3>

        {/* Metrics Grid */}
        <div className="grid grid-cols-4 gap-4 mb-6">
          <div className="bg-gradient-to-br from-indigo-50 to-indigo-100 dark:from-indigo-900/20 dark:to-indigo-800/20 rounded-lg p-4 text-center border border-indigo-200 dark:border-indigo-800">
            <div className="text-3xl font-bold text-indigo-600 dark:text-indigo-400">
              {analysis.metrics.schemaCount}
            </div>
            <div className="text-xs text-indigo-700 dark:text-indigo-300 mt-1 font-medium">
              Schemas
            </div>
          </div>
          <div className="bg-gradient-to-br from-purple-50 to-purple-100 dark:from-purple-900/20 dark:to-purple-800/20 rounded-lg p-4 text-center border border-purple-200 dark:border-purple-800">
            <div className="text-3xl font-bold text-purple-600 dark:text-purple-400">
              {analysis.metrics.propertyCount}
            </div>
            <div className="text-xs text-purple-700 dark:text-purple-300 mt-1 font-medium">
              Properties
            </div>
          </div>
          <div className="bg-gradient-to-br from-blue-50 to-blue-100 dark:from-blue-900/20 dark:to-blue-800/20 rounded-lg p-4 text-center border border-blue-200 dark:border-blue-800">
            <div className="text-3xl font-bold text-blue-600 dark:text-blue-400">
              {analysis.metrics.referenceCount}
            </div>
            <div className="text-xs text-blue-700 dark:text-blue-300 mt-1 font-medium">
              References
            </div>
          </div>
          <div className="bg-gradient-to-br from-teal-50 to-teal-100 dark:from-teal-900/20 dark:to-teal-800/20 rounded-lg p-4 text-center border border-teal-200 dark:border-teal-800">
            <div className="text-3xl font-bold text-teal-600 dark:text-teal-400">
              {analysis.metrics.pathCount}
            </div>
            <div className="text-xs text-teal-700 dark:text-teal-300 mt-1 font-medium">
              Paths
            </div>
          </div>
        </div>

        {/* Additional Info */}
        <div className="space-y-2 text-sm">
          <div className="flex items-center justify-between py-2 border-b border-gray-100 dark:border-gray-700">
            <span className="text-gray-600 dark:text-gray-400">External References:</span>
            <span className="font-medium text-gray-900 dark:text-white">
              {analysis.metrics.externalReferences.length > 0
                ? `${analysis.metrics.externalReferences.length} URLs detected`
                : 'None'}
            </span>
          </div>
          <div className="flex items-center justify-between py-2 border-b border-gray-100 dark:border-gray-700">
            <span className="text-gray-600 dark:text-gray-400">Circular References:</span>
            <div className="flex items-center gap-2">
              {analysis.metrics.circularReferences.length === 0 ? (
                <>
                  <CheckCircle2 className="h-4 w-4 text-green-600 dark:text-green-400" />
                  <span className="font-medium text-gray-900 dark:text-white">None detected</span>
                </>
              ) : (
                <>
                  <AlertCircle className="h-4 w-4 text-yellow-600 dark:text-yellow-400" />
                  <span className="font-medium text-gray-900 dark:text-white">
                    {analysis.metrics.circularReferences.length} detected
                  </span>
                </>
              )}
            </div>
          </div>
          {analysis.metrics.customExtensions.length > 0 && (
            <div className="py-2 border-b border-gray-100 dark:border-gray-700">
              <div className="flex items-center justify-between mb-1.5">
                <span className="text-gray-600 dark:text-gray-400">Custom Extensions (x-):</span>
                <span className="font-medium text-gray-900 dark:text-white">
                  {analysis.metrics.customExtensions.length} total
                </span>
              </div>
              <div className="flex flex-wrap gap-1.5 mt-1">
                {[...analysis.metrics.customExtensions].sort().map((ext) => (
                  <span
                    key={ext}
                    className="inline-flex items-center px-2 py-0.5 rounded text-xs font-mono bg-gray-100 dark:bg-gray-700 text-gray-800 dark:text-gray-200 border border-gray-200 dark:border-gray-600"
                  >
                    {ext}
                  </span>
                ))}
              </div>
            </div>
          )}
          {(analysis.metrics.compositionSchemas.allOf > 0 ||
            analysis.metrics.compositionSchemas.oneOf > 0 ||
            analysis.metrics.compositionSchemas.anyOf > 0) && (
            <div className="flex items-center justify-between py-2">
              <span className="text-gray-600 dark:text-gray-400">Schema Composition:</span>
              <div className="flex items-center gap-3">
                {analysis.metrics.compositionSchemas.allOf > 0 && (
                  <span className="text-xs px-2 py-1 bg-blue-100 dark:bg-blue-900/30 text-blue-700 dark:text-blue-300 rounded font-medium">
                    allOf: {analysis.metrics.compositionSchemas.allOf}
                  </span>
                )}
                {analysis.metrics.compositionSchemas.oneOf > 0 && (
                  <span className="text-xs px-2 py-1 bg-purple-100 dark:bg-purple-900/30 text-purple-700 dark:text-purple-300 rounded font-medium">
                    oneOf: {analysis.metrics.compositionSchemas.oneOf}
                  </span>
                )}
                {analysis.metrics.compositionSchemas.anyOf > 0 && (
                  <span className="text-xs px-2 py-1 bg-indigo-100 dark:bg-indigo-900/30 text-indigo-700 dark:text-indigo-300 rounded font-medium">
                    anyOf: {analysis.metrics.compositionSchemas.anyOf}
                  </span>
                )}
              </div>
            </div>
          )}
        </div>
      </div>

      {/* Quality Score */}
      <div className="bg-white dark:bg-gray-800 rounded-xl border border-gray-200 dark:border-gray-700 p-6">
        <h3 className="text-lg font-semibold text-gray-900 dark:text-white mb-4">
          Quality Score
        </h3>

        {/* Overall score + letter grade (colors follow numeric bands #248) */}
        <div className="flex items-center justify-between mb-4 p-6 bg-gradient-to-br from-gray-50 to-gray-100 dark:from-gray-900/50 dark:to-gray-800/50 rounded-lg border border-gray-200 dark:border-gray-700">
          <div className="flex items-center gap-4">
            <div className={`text-6xl font-bold ${overallTier.textClass}`} title={`${overallTier.shortLabel} (${overallTier.rangeLabel})`}>
              {analysis.qualityScore.grade}
            </div>
            <div>
              <div className={`text-lg font-semibold ${overallTier.textClass}`}>
                {overallTier.shortLabel} — {overallTier.detailLabel}
              </div>
              <div className="text-sm text-gray-600 dark:text-gray-400">
                Based on specification analysis · {overallTier.rangeLabel}
              </div>
            </div>
          </div>
          <div className="text-right">
            <div className={`text-3xl font-bold ${overallTier.textClass} tabular-nums`}>
              {analysis.qualityScore.overall}
            </div>
            <div className="text-xs text-gray-500 dark:text-gray-400 tabular-nums">/ 100 pts</div>
          </div>
        </div>
        <p className="text-sm text-gray-600 dark:text-gray-400 mb-4">
          Weighted score by category (Design Quality 30, Documentation 20, API Best Practices 25, Security 15,
          Performance 10).
        </p>
        <div className="mb-6 rounded-lg border border-gray-200 dark:border-gray-700 bg-gray-50/80 dark:bg-gray-900/40 px-3 py-2">
          <div className="text-2xs font-medium uppercase tracking-wider text-gray-500 dark:text-gray-400 mb-2">
            Score guide
          </div>
          <ul className="grid grid-cols-1 sm:grid-cols-2 gap-x-4 gap-y-1.5 text-xs text-gray-700 dark:text-gray-300">
            {NUMERIC_SCORE_TIER_LEGEND.map((row) => (
              <li key={row.band} className="flex items-start gap-2">
                <span className={`mt-1.5 h-2 w-2 shrink-0 rounded-full ${row.barSolidClass}`} aria-hidden />
                <span>
                  <span className="font-medium tabular-nums">{row.rangeLabel}:</span>{' '}
                  {row.shortLabel} — {row.detailLabel}
                </span>
              </li>
            ))}
          </ul>
        </div>

        {/* Quality Metrics — weighted categories (#247) */}
        <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-3 gap-4">
          {CATEGORY_ORDER.map((id) => {
            const cat = categories[id];
            const accent = categoryAccent[id];
            const pct = cat.percent;
            const issueCount = getIssuesForCategory(id).length;
            return (
              <div
                key={id}
                onClick={() => setSelectedCategory(id)}
                className={`relative bg-gray-50 dark:bg-gray-900/30 rounded-lg p-4 border border-gray-200 dark:border-gray-700 cursor-pointer ${accent.hover} hover:shadow-md transition-all group`}
              >
                <div className="flex items-start justify-between gap-2 mb-2">
                  <span className="text-xs font-medium text-gray-600 dark:text-gray-400 uppercase tracking-wider leading-tight">
                    {cat.label}
                  </span>
                  <div className="text-right shrink-0">
                    <div className={`text-sm font-bold tabular-nums ${getNumericScoreTier(pct).textClass}`}>
                      {cat.points}/{cat.maxPoints}
                    </div>
                    <div className="text-2xs text-gray-500 dark:text-gray-400 tabular-nums">{pct}%</div>
                  </div>
                </div>
                <Progress.Root
                  className="relative h-2 w-full overflow-hidden rounded-full bg-gray-200 dark:bg-gray-700"
                  value={pct}
                >
                  <Progress.Indicator
                    className={`h-full bg-gradient-to-r ${getNumericScoreTier(pct).progressGradientClass} transition-transform duration-300`}
                    style={{ transform: `translateX(-${100 - pct}%)` }}
                  />
                </Progress.Root>
                <div className="flex items-center justify-between mt-2 gap-2">
                  <span className="text-xs text-gray-500 dark:text-gray-400 line-clamp-2">{cat.description}</span>
                  {issueCount > 0 && (
                    <span
                      className={`text-xs shrink-0 flex items-center gap-1 group-hover:underline ${accent.issue}`}
                    >
                      {issueCount} issues <ChevronRight className="h-3 w-3" />
                    </span>
                  )}
                </div>
              </div>
            );
          })}
        </div>

        {/* Quality Issues Detail Dialog */}
        <Dialog.Root open={selectedCategory !== null} onOpenChange={(open) => !open && setSelectedCategory(null)}>
          <Dialog.Portal>
            <Dialog.Overlay className="fixed inset-0 bg-black/50 z-[10000]" />
            <Dialog.Content
              aria-describedby={undefined}
              className="fixed top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 bg-white dark:bg-gray-800 rounded-xl shadow-2xl z-[10001] w-full max-w-2xl max-h-[80vh] overflow-hidden"
            >
              {selectedCategory && (
                <>
                  <div className={`p-6 bg-gradient-to-r ${getCategoryGradient(selectedCategory)} text-white`}>
                    <div className="flex items-center justify-between">
                      <div>
                        <Dialog.Title className="text-xl font-bold">
                          {categoryDescriptions[selectedCategory].title}
                        </Dialog.Title>
                        <Dialog.Description className="text-white/80 mt-1 text-sm">
                          {categoryDescriptions[selectedCategory].description}
                        </Dialog.Description>
                      </div>
                      <Dialog.Close asChild>
                        <button className="p-2 rounded-lg hover:bg-white/20 transition-colors">
                          <X className="h-5 w-5" />
                        </button>
                      </Dialog.Close>
                    </div>
                  </div>

                  <div className="p-6 overflow-y-auto max-h-[calc(80vh-140px)]">
                    <h4 className="text-lg font-semibold text-gray-900 dark:text-white mb-4">
                      These are the suggested improvements
                    </h4>

                    {getIssuesForCategory(selectedCategory).length === 0 ? (
                      <div className="flex items-center justify-center py-12 text-center">
                        <div>
                          <CheckCircle2 className="h-12 w-12 text-green-500 mx-auto mb-3" />
                          <div className="text-lg font-medium text-gray-900 dark:text-white">
                            No issues found!
                          </div>
                          <div className="text-sm text-gray-500 dark:text-gray-400 mt-1">
                            Your specification meets all requirements for this category.
                          </div>
                        </div>
                      </div>
                    ) : (
                      <div className="space-y-4">
                        {getIssuesForCategory(selectedCategory).map((issue, index) => (
                          <div
                            key={index}
                            className="bg-gray-50 dark:bg-gray-900/30 rounded-lg p-4 border border-gray-200 dark:border-gray-700"
                          >
                            <div className="flex items-start gap-3">
                              <AlertCircle className={`h-5 w-5 mt-0.5 flex-shrink-0 ${
                                issue.severity === 'high' ? 'text-red-500' :
                                issue.severity === 'medium' ? 'text-yellow-500' : 'text-blue-500'
                              }`} />
                              <div className="flex-1 min-w-0">
                                <div className="flex items-center gap-2 mb-1">
                                  <span className="text-sm font-medium text-gray-900 dark:text-white">
                                    {issue.message}
                                  </span>
                                  <span className={`text-xs px-2 py-0.5 rounded-full font-medium ${getSeverityColor(issue.severity)}`}>
                                    {issue.severity}
                                  </span>
                                </div>
                                <div className="text-sm text-gray-600 dark:text-gray-400 mb-2">
                                  {issue.suggestion}
                                </div>
                                <div className="flex items-center gap-2 text-xs">
                                  <span className="px-2 py-1 bg-gray-200 dark:bg-gray-700 rounded font-mono text-gray-700 dark:text-gray-300">
                                    {issue.path}
                                  </span>
                                  {issue.line && (
                                    <span className="text-gray-500 dark:text-gray-400">
                                      Line {issue.line}
                                    </span>
                                  )}
                                </div>
                              </div>
                            </div>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                </>
              )}
            </Dialog.Content>
          </Dialog.Portal>
        </Dialog.Root>
      </div>

      {/* Errors */}
      {analysis.errors.length > 0 && (
        <div className="bg-red-50 dark:bg-red-900/20 rounded-xl border-2 border-red-200 dark:border-red-800 p-6">
          <h3 className="text-lg font-semibold text-red-900 dark:text-red-300 mb-4 flex items-center gap-2">
            <XCircle className="h-5 w-5" />
            Errors ({analysis.errors.length})
          </h3>
          <div className="space-y-2">
            {analysis.errors.map((error, index) => (
              <div key={index} className="flex items-start gap-2 text-sm">
                <XCircle className="h-4 w-4 text-red-600 dark:text-red-400 mt-0.5 flex-shrink-0" />
                <div>
                  <div className="text-red-900 dark:text-red-200 font-medium">{error.message}</div>
                  {error.path && (
                    <div className="text-red-700 dark:text-red-400 text-xs mt-1">
                      Path: {error.path}
                    </div>
                  )}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Warnings */}
      {analysis.warnings.length > 0 && (
        <div className="bg-yellow-50 dark:bg-yellow-900/20 rounded-xl border-2 border-yellow-200 dark:border-yellow-800 p-6">
          <h3 className="text-lg font-semibold text-yellow-900 dark:text-yellow-300 mb-4 flex items-center gap-2">
            <AlertCircle className="h-5 w-5" />
            Warnings ({analysis.warnings.length})
          </h3>
          <div className="space-y-2">
            {analysis.warnings.slice(0, 5).map((warning, index) => (
              <div key={index} className="flex items-start gap-2 text-sm">
                <AlertCircle className="h-4 w-4 text-yellow-600 dark:text-yellow-400 mt-0.5 flex-shrink-0" />
                <div className="text-yellow-900 dark:text-yellow-200">{warning.message}</div>
              </div>
            ))}
            {analysis.warnings.length > 5 && (
              <div className="text-xs text-yellow-700 dark:text-yellow-400 mt-2 italic">
                + {analysis.warnings.length - 5} more warnings
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

