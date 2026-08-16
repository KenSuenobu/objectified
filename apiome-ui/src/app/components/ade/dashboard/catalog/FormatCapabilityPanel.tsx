'use client';

/**
 * `<FormatCapabilityPanel>` (CPDO-2.4, #4796) — the honest "what can apiome tell me about this
 * format?" panel.
 *
 * Renders one {@link FormatCapability} entry from the source-format capability & parsing-limit
 * registry: the native hierarchy its analyzer models, the source pointers it can offer, the value
 * material it can ever carry, the grammar it knowingly does not read, what survives normalization,
 * whether it converts — and, at the bottom, the analyzer/tool versions backing every one of those
 * claims, so the panel is evidence rather than assertion.
 *
 * **The rule the panel exists to keep.** When an analysis has no detail, the reason is rendered
 * from the registry's reviewed wording and the "the source was not captured" phrasing is gated on
 * `absence.source_missing` — true for exactly one category. A bounds/grammar parse limit, an
 * unsupported format, an analyzer failure and a redaction each get their own wording, and the two
 * construct lists are captioned with what their absence from a tree *means*, so an unmodelled
 * construct is never read as missing data.
 *
 * Purely presentational: it takes a resolved entry and (optionally) a resolved absence explanation,
 * so every branch is unit-testable without a fetch. `useFormatCapabilities` loads and validates the
 * snapshot the caller resolves them from.
 */

import * as React from 'react';
import { AlertTriangle, FileSearch, Info, Layers, MapPin, ShieldCheck } from 'lucide-react';
import { cn } from '@lib/utils';
import {
  renderAbsence,
  type AbsenceExplanation,
  type FormatCapability,
} from './formatCapabilityRegistry';

export interface FormatCapabilityPanelProps {
  /** The resolved capability entry to render. */
  capability: FormatCapability;
  /**
   * The reviewed explanation for why this item's analysis has no detail, when it has none.
   * Omit for an available analysis — there is then no absence to explain.
   */
  absence?: AbsenceExplanation | null;
  /** Optional construct key the absence is about, named in the rendered sentence. */
  absenceConstruct?: string | null;
  className?: string;
}

/** Human labels for the vocabulary, so no badge is a bare enum value. */
const PROVENANCE_LABEL: Record<FormatCapability['provenance'], string> = {
  reviewed: 'Reviewed',
  derived: 'Derived from adapter',
  unknown_format: 'Unknown format',
};

const AVAILABILITY_LABEL: Record<FormatCapability['availability'], string> = {
  available: 'Available',
  tool_unavailable: 'Toolchain unavailable',
  preview_only: 'Preview only',
  unregistered: 'Not registered',
};

const HIERARCHY_LABEL: Record<FormatCapability['native_hierarchy'], string> = {
  native: 'Format-native structure',
  generic: 'Generic structure only',
  none: 'No structure recorded',
};

const LOCATION_LABEL: Record<FormatCapability['source_location']['quality'], string> = {
  byte_offsets: 'Byte offsets',
  line_numbers: 'Source line numbers',
  path_only: 'Structural path only',
  none: 'No source pointer',
};

const COVERAGE_LABEL: Record<FormatCapability['canonical_projection']['coverage'], string> = {
  full: 'Fully projected',
  partial: 'Partially projected',
  none: 'Not projected',
  unknown: 'Not reviewed',
};

const CONVERSION_LABEL: Record<FormatCapability['conversion']['support'], string> = {
  supported: 'Converts to every export target',
  tool_unavailable: 'Toolchain unavailable here',
  unsupported: 'No conversion route',
};

const VISIBILITY_LABEL: Record<string, string> = {
  none: 'No value material',
  structural: 'Presence and length only',
  full: 'Full value preview',
};

/** Human labels for the numeric limit keys the analyzers report. */
const LIMIT_LABEL: Record<string, string> = {
  maxNodes: 'Nodes kept',
  maxDepth: 'Depth kept',
  maxVisitedNodes: 'Nodes visited',
  valuePreviewChars: 'Value preview characters',
};

/** Tone classes per badge state. Text always carries the meaning; colour only reinforces it. */
const NEUTRAL_BADGE =
  'border-gray-200 bg-gray-50 text-gray-700 dark:border-gray-700 dark:bg-gray-900/40 dark:text-gray-300';
const POSITIVE_BADGE =
  'border-emerald-200 bg-emerald-50 text-emerald-700 dark:border-emerald-800/60 dark:bg-emerald-950/30 dark:text-emerald-300';
const CAUTION_BADGE =
  'border-amber-200 bg-amber-50 text-amber-700 dark:border-amber-800/60 dark:bg-amber-950/30 dark:text-amber-300';

const BADGE_BASE =
  'inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-2xs font-medium';

/** A labelled badge. `tone` reinforces the label; it never replaces it. */
function Badge({
  label,
  value,
  tone,
}: {
  label: string;
  value: string;
  tone: 'neutral' | 'positive' | 'caution';
}) {
  return (
    <span
      className={cn(
        BADGE_BASE,
        tone === 'positive' ? POSITIVE_BADGE : tone === 'caution' ? CAUTION_BADGE : NEUTRAL_BADGE,
      )}
    >
      <span className="sr-only">{label}: </span>
      {value}
    </span>
  );
}

/** One titled block with an icon, a short statement, and the reviewed note under it. */
function Facet({
  icon: Icon,
  title,
  statement,
  note,
}: {
  icon: React.ComponentType<{ className?: string; 'aria-hidden'?: boolean }>;
  title: string;
  statement: string;
  note: string;
}) {
  return (
    <div className="rounded-md border border-gray-100 bg-gray-50/60 p-3 dark:border-gray-700/60 dark:bg-gray-900/30">
      <h4 className="flex items-center gap-1.5 text-xs font-semibold text-gray-900 dark:text-gray-100">
        <Icon className="h-3.5 w-3.5 text-gray-400 dark:text-gray-500" aria-hidden />
        {title}
      </h4>
      <p className="mt-1 text-xs font-medium text-gray-700 dark:text-gray-300">{statement}</p>
      <p className="mt-1 text-2xs leading-snug text-gray-500 dark:text-gray-400">{note}</p>
    </div>
  );
}

/**
 * A construct list with a caption stating what a construct's *absence from a tree* means. The
 * caption is the point: a bare "not modelled" list invites the reader to conclude the data is
 * missing, which is the failure this whole registry exists to prevent.
 */
function ConstructList({
  headingId,
  title,
  caption,
  constructs,
  emptyNote,
}: {
  headingId: string;
  title: string;
  caption: string;
  constructs: string[];
  emptyNote: string;
}) {
  return (
    <section aria-labelledby={headingId} className="min-w-0">
      <h4
        id={headingId}
        className="text-xs font-semibold text-gray-900 dark:text-gray-100"
      >
        {title}
      </h4>
      <p className="mt-0.5 text-2xs leading-snug text-gray-500 dark:text-gray-400">{caption}</p>
      {constructs.length === 0 ? (
        <p className="mt-2 text-2xs italic text-gray-500 dark:text-gray-400">{emptyNote}</p>
      ) : (
        <ul className="mt-2 flex flex-wrap gap-1.5">
          {constructs.map((construct) => (
            <li
              key={construct}
              className="rounded border border-gray-200 bg-white px-1.5 py-0.5 font-mono text-2xs text-gray-700 dark:border-gray-700 dark:bg-gray-900/40 dark:text-gray-300"
            >
              {construct}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

/**
 * The format capability panel.
 *
 * @param capability The resolved registry entry to render.
 * @param absence The reviewed explanation for a missing analysis, when there is one.
 * @param absenceConstruct The construct the absence is about, named in the sentence.
 */
export function FormatCapabilityPanel({
  capability,
  absence,
  absenceConstruct,
  className,
}: FormatCapabilityPanelProps) {
  const headingId = `format-capability-${capability.format}`;
  const toolVersions = Object.entries(capability.analyzer.tool_versions);
  const limits = Object.entries(capability.limits);
  const available = capability.availability === 'available';

  return (
    <section
      aria-labelledby={headingId}
      className={cn(
        'rounded-lg border border-gray-200 bg-white p-4 dark:border-gray-700 dark:bg-gray-800',
        className,
      )}
    >
      <header className="flex flex-wrap items-center gap-2">
        <h3
          id={headingId}
          className="text-sm font-semibold text-gray-900 dark:text-gray-100"
        >
          {capability.label} — what apiome records
        </h3>
        <Badge
          label="Entry provenance"
          value={PROVENANCE_LABEL[capability.provenance]}
          tone={capability.provenance === 'reviewed' ? 'positive' : 'neutral'}
        />
        <Badge
          label="Availability"
          value={AVAILABILITY_LABEL[capability.availability]}
          tone={available ? 'positive' : 'caution'}
        />
      </header>

      {capability.unavailable_reason ? (
        <p className="mt-2 flex items-start gap-1.5 text-xs text-amber-700 dark:text-amber-400">
          <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden />
          {capability.unavailable_reason}
        </p>
      ) : null}

      {absence ? (
        <div
          role="note"
          aria-label="Why this detail is missing"
          className="mt-3 rounded-md border border-indigo-200 bg-indigo-50/60 p-3 dark:border-indigo-800/60 dark:bg-indigo-950/20"
        >
          <p className="flex items-center gap-1.5 text-xs font-semibold text-indigo-900 dark:text-indigo-200">
            <Info className="h-3.5 w-3.5" aria-hidden />
            {absence.category_label}
          </p>
          <p className="mt-1 text-xs leading-snug text-indigo-900/90 dark:text-indigo-200/90">
            {renderAbsence(absence, absenceConstruct ?? null)}
          </p>
          <p className="mt-1 text-2xs leading-snug text-indigo-800/80 dark:text-indigo-300/80">
            {absence.remediation}
          </p>
          {/*
           * Gated on the flag, never on the status: exactly one category means the customer's
           * source material is genuinely absent. Every other cause renders the counter-statement
           * instead, so a parser limit can never be read as missing data.
           */}
          <p className="mt-1.5 text-2xs font-medium text-indigo-800 dark:text-indigo-300">
            {absence.source_missing
              ? 'No source material was captured for this revision.'
              : 'The source material is unaffected — this describes what apiome recorded, not what the source contains.'}
          </p>
        </div>
      ) : null}

      <div className="mt-3 grid grid-cols-1 gap-2 sm:grid-cols-3">
        <Facet
          icon={Layers}
          title="Structure"
          statement={HIERARCHY_LABEL[capability.native_hierarchy]}
          note={capability.native_hierarchy_note}
        />
        <Facet
          icon={MapPin}
          title="Source locations"
          statement={LOCATION_LABEL[capability.source_location.quality]}
          note={capability.source_location.note}
        />
        <Facet
          icon={ShieldCheck}
          title="Values"
          statement={
            VISIBILITY_LABEL[capability.value_visibility.maximum] ??
            capability.value_visibility.maximum
          }
          note={capability.value_visibility.note}
        />
      </div>

      <div className="mt-3 grid grid-cols-1 gap-4 sm:grid-cols-2">
        <ConstructList
          headingId={`${headingId}-modelled`}
          title="Modelled"
          caption="If one of these is absent from an analysis, the source did not contain it."
          constructs={capability.supported_constructs}
          emptyNote="This analyzer names no format constructs."
        />
        <ConstructList
          headingId={`${headingId}-unmodelled`}
          title="Not modelled (parsing limits)"
          caption="apiome does not describe these. Their absence says nothing about the source, which may well contain them."
          constructs={capability.unsupported_constructs}
          emptyNote="This analyzer declares no grammar it cannot read."
        />
      </div>

      <div className="mt-3 grid grid-cols-1 gap-2 sm:grid-cols-2">
        <section
          aria-labelledby={`${headingId}-projection`}
          className="rounded-md border border-gray-100 bg-gray-50/60 p-3 dark:border-gray-700/60 dark:bg-gray-900/30"
        >
          <h4
            id={`${headingId}-projection`}
            className="flex items-center gap-1.5 text-xs font-semibold text-gray-900 dark:text-gray-100"
          >
            <FileSearch className="h-3.5 w-3.5 text-gray-400 dark:text-gray-500" aria-hidden />
            Canonical projection
          </h4>
          <p className="mt-1 text-xs font-medium text-gray-700 dark:text-gray-300">
            {COVERAGE_LABEL[capability.canonical_projection.coverage]}
          </p>
          <p className="mt-1 text-2xs leading-snug text-gray-500 dark:text-gray-400">
            {capability.canonical_projection.note}
          </p>
          {capability.canonical_projection.dropped_constructs.length > 0 ? (
            <ul className="mt-2 flex flex-wrap gap-1.5">
              {capability.canonical_projection.dropped_constructs.map((construct) => (
                <li
                  key={construct}
                  className="rounded border border-gray-200 bg-white px-1.5 py-0.5 font-mono text-2xs text-gray-700 dark:border-gray-700 dark:bg-gray-900/40 dark:text-gray-300"
                >
                  {construct}
                </li>
              ))}
            </ul>
          ) : null}
        </section>

        <section
          aria-labelledby={`${headingId}-conversion`}
          className="rounded-md border border-gray-100 bg-gray-50/60 p-3 dark:border-gray-700/60 dark:bg-gray-900/30"
        >
          <h4
            id={`${headingId}-conversion`}
            className="text-xs font-semibold text-gray-900 dark:text-gray-100"
          >
            Conversion
          </h4>
          <p className="mt-1 text-xs font-medium text-gray-700 dark:text-gray-300">
            {CONVERSION_LABEL[capability.conversion.support]}
          </p>
          <p className="mt-1 text-2xs leading-snug text-gray-500 dark:text-gray-400">
            {capability.conversion.note}
          </p>
        </section>
      </div>

      {limits.length > 0 ? (
        <section aria-labelledby={`${headingId}-limits`} className="mt-3">
          <h4
            id={`${headingId}-limits`}
            className="text-xs font-semibold text-gray-900 dark:text-gray-100"
          >
            Parsing limits
          </h4>
          <dl className="mt-1 flex flex-wrap gap-x-4 gap-y-1 text-2xs text-gray-600 dark:text-gray-400">
            {limits.map(([name, value]) => (
              <div key={name} className="flex items-baseline gap-1">
                <dt className="font-medium">{LIMIT_LABEL[name] ?? name}</dt>
                <dd className="font-mono">{value.toLocaleString()}</dd>
              </div>
            ))}
          </dl>
        </section>
      ) : null}

      {capability.notes.length > 0 ? (
        <section aria-labelledby={`${headingId}-notes`} className="mt-3">
          <h4
            id={`${headingId}-notes`}
            className="text-xs font-semibold text-gray-900 dark:text-gray-100"
          >
            Boundaries
          </h4>
          <ul className="mt-1 list-disc space-y-1 pl-4 text-2xs leading-snug text-gray-600 dark:text-gray-400">
            {capability.notes.map((note) => (
              <li key={note}>{note}</li>
            ))}
          </ul>
        </section>
      ) : null}

      <footer className="mt-3 border-t border-gray-100 pt-2 text-2xs text-gray-500 dark:border-gray-700/60 dark:text-gray-400">
        <p>
          Analyzer{' '}
          <span className="font-mono">
            {capability.analyzer.key}@{capability.analyzer.version}
          </span>
          {toolVersions.length > 0 ? (
            <>
              {' · '}
              {toolVersions.map(([tool, version], index) => (
                <React.Fragment key={tool}>
                  {index > 0 ? ', ' : null}
                  <span className="font-mono">
                    {tool} {version}
                  </span>
                </React.Fragment>
              ))}
            </>
          ) : null}
        </p>
        <p>
          Capability registry v{capability.registry_version} · reviewed {capability.review_date}
        </p>
      </footer>
    </section>
  );
}

export default FormatCapabilityPanel;
