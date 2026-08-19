'use client';

/**
 * The Catalog item detail's **Provenance** pane (HIVE-7.2, #5319).
 *
 * Authority: `docs/mockups/sources/catalog-item.html` §Provenance — the four-step rail whose
 * titles and captions the mockup's Keeps list fixes verbatim, each step carrying the facts its
 * stage of the import produced.
 *
 * The rail this replaces drew its connector as an absolutely-positioned `bg-gray-200
 * dark:bg-gray-700` hairline pinned with four magic offsets, and its four icon badges as
 * `border-indigo-200 bg-indigo-50 text-indigo-600 dark:…`. The connector is a `::after` on the
 * icon tile now (`.cid-step`), which means it cannot drift when the font scale changes the row
 * height, and the tiles are `.tnt-icon-tile[data-tone]` — the same tinted square the tenants
 * drawer, the roles rail and six other surfaces already draw.
 *
 * @see `./catalogItemView.ts` — the step titles, captions, glyph keys and absent-copy.
 */

import * as React from 'react';
import {
  CalendarClock,
  ClipboardPaste,
  FileUp,
  Globe,
  Library,
  Radar,
  ScanSearch,
  User,
  Wrench,
} from 'lucide-react';

import { Badge } from '@/app/components/ui/Badge';
import { Card, CardBody, CardHeader, CardTitle } from '@/app/components/ui/Card';
import { FormatPill } from '@/app/components/ui/catalog/FormatPill';
import { ProtocolPill } from '@/app/components/ui/catalog/ProtocolPill';
import { SourceBadge } from '@/app/components/ui/catalog/SourceBadge';
import type { CatalogSource } from '@/app/utils/catalog-format-registry';
import { formatRelativeTimestamp } from '@/app/utils/catalog-detail-insights';

import {
  CATALOG_PROVENANCE_STEPS,
  PROVENANCE_ABSENT,
  catalogDetailTimestamp,
  catalogImportJobRef,
  catalogSourceChips,
  catalogSourceKindView,
  catalogToolVersions,
  type CatalogSourceDescriptor,
} from './catalogItemView';

/** The glyph for each step and each intake kind — the same lookup shape the Overview uses. */
const GLYPH: Readonly<Record<string, React.ComponentType<{ className?: string }>>> = {
  file: FileUp,
  url: Globe,
  paste: ClipboardPaste,
  discovery: Radar,
  detection: ScanSearch,
  normalization: Wrench,
  record: Library,
};

/** The tone a source chip resolves to, in `Badge`'s vocabulary. */
const CHIP_VARIANT = { ok: 'ok', accent: 'accent', neutral: 'neutral' } as const;

export interface CatalogItemProvenanceProps {
  /** Where the item was imported from. */
  source: CatalogSourceDescriptor | null;
  /** The source-material badge the format registry resolved, when it resolved one. */
  resolvedSource: CatalogSource | undefined;
  /** The format the importer detected. */
  sourceFormat: string | null;
  /** The protocol it detected. */
  protocol: string | null;
  /** The toolchain bag the import recorded. */
  toolVersions: Record<string, unknown> | null | undefined;
  /** The format-metadata bag the import-job reference travels in. */
  formatMetadata: Record<string, unknown> | null | undefined;
  /** Who ran the import. */
  creatorName: string | null | undefined;
  /** Their address, when the name was not recorded. */
  creatorEmail: string | null | undefined;
  /** When the item was minted. */
  createdAt: string | null | undefined;
  /** When it last changed. */
  updatedAt: string | null | undefined;
}

/**
 * One step of the rail: a tinted glyph tile, a caps "Step N · Title" line, the caption, and
 * whatever the step produced.
 *
 * @param props.step The step's ordinal, title, caption, glyph key and tone.
 * @param props.children The facts the step produced.
 * @returns A `<li>` on the rail.
 */
function ProvenanceStep({
  step,
  title,
  caption,
  icon,
  tone,
  testId,
  children,
}: {
  step: number;
  title: string;
  caption: string;
  icon: string;
  tone: string;
  testId: string;
  children: React.ReactNode;
}) {
  const Glyph = GLYPH[icon] ?? FileUp;
  return (
    <li className="cid-step" data-testid={testId}>
      <span className="tnt-icon-tile cid-step__tile" data-tone={tone} aria-hidden>
        <Glyph />
      </span>
      <div className="min-w-0">
        <p className="cid-caps">
          Step {step} · {title}
        </p>
        <p className="cid-step__caption">{caption}</p>
        <div className="cid-step__body">{children}</div>
      </div>
    </li>
  );
}

/**
 * Render the Provenance pane. See {@link CatalogItemProvenanceProps}.
 *
 * @returns The card holding the four-step rail.
 */
export function CatalogItemProvenance({
  source,
  resolvedSource,
  sourceFormat,
  protocol,
  toolVersions,
  formatMetadata,
  creatorName,
  creatorEmail,
  createdAt,
  updatedAt,
}: CatalogItemProvenanceProps) {
  const [intake, detection, normalization, record] = CATALOG_PROVENANCE_STEPS;
  const tools = catalogToolVersions(toolVersions);
  const importJobRef = catalogImportJobRef(formatMetadata);
  const createdRelative = formatRelativeTimestamp(createdAt);
  const updatedRelative = formatRelativeTimestamp(updatedAt);

  return (
    <Card data-testid="catalog-detail-provenance">
      <CardHeader>
        <div>
          <CardTitle>
            <ScanSearch aria-hidden />
            Provenance
          </CardTitle>
          <p className="cid-note">How this item reached the catalog</p>
        </div>
      </CardHeader>
      <CardBody>
        <ol className="cid-rail">
          <ProvenanceStep
            step={intake.step}
            title={intake.title}
            caption={intake.caption}
            icon={catalogSourceKindView(source?.kind ?? null).icon}
            tone={intake.tone}
            testId="catalog-detail-stage-intake"
          >
            <div className="cid-chips">
              <span className="cid-step__name mono" title={source?.label || source?.uri || undefined}>
                {source?.label || source?.uri || PROVENANCE_ABSENT.intake}
              </span>
              {source?.kind ? (
                <Badge variant="outline">{catalogSourceKindView(source.kind).label}</Badge>
              ) : null}
              {catalogSourceChips(source)
                .filter((chip) => !chip.uri)
                .map((chip) => (
                  <Badge key={chip.label} variant={CHIP_VARIANT[chip.tone]}>
                    {chip.label}
                  </Badge>
                ))}
              {resolvedSource ? <SourceBadge source={resolvedSource} /> : null}
            </div>
            {source?.uri && source?.label ? (
              <p className="cid-micro mono cid-step__uri" title={source.uri}>
                {source.uri}
              </p>
            ) : null}
          </ProvenanceStep>

          <ProvenanceStep
            step={detection.step}
            title={detection.title}
            caption={detection.caption}
            icon={detection.icon}
            tone={detection.tone}
            testId="catalog-detail-stage-detection"
          >
            {sourceFormat || protocol ? (
              <div className="cid-chips">
                <FormatPill format={sourceFormat} />
                <ProtocolPill protocol={protocol} />
              </div>
            ) : (
              <p className="cid-note">{PROVENANCE_ABSENT.detection}</p>
            )}
          </ProvenanceStep>

          <ProvenanceStep
            step={normalization.step}
            title={normalization.title}
            caption={normalization.caption}
            icon={normalization.icon}
            tone={normalization.tone}
            testId="catalog-detail-stage-normalization"
          >
            {tools.length > 0 ? (
              <div className="cid-chips">
                {tools.map(({ tool, version }) => (
                  <Badge key={tool} variant="outline" mono>
                    <Wrench aria-hidden />
                    {tool} {version}
                  </Badge>
                ))}
              </div>
            ) : (
              <p className="cid-note">{PROVENANCE_ABSENT.normalization}</p>
            )}
          </ProvenanceStep>

          <ProvenanceStep
            step={record.step}
            title={record.title}
            caption={record.caption}
            icon={record.icon}
            tone={record.tone}
            testId="catalog-detail-stage-record"
          >
            <dl className="cid-kv">
              <dt>Import job</dt>
              <dd>
                {importJobRef ? (
                  <Badge variant="neutral" mono title={importJobRef}>
                    {importJobRef}
                  </Badge>
                ) : (
                  <span className="cid-absent">{PROVENANCE_ABSENT.record}</span>
                )}
              </dd>
              <dt>Created by</dt>
              <dd>
                <User aria-hidden className="cid-kv__glyph" />
                {creatorName || creatorEmail || 'Unknown'}
              </dd>
              <dt>Created</dt>
              <dd>
                <CalendarClock aria-hidden className="cid-kv__glyph" />
                {catalogDetailTimestamp(createdAt)}
                {createdRelative ? <span className="cid-quiet"> · {createdRelative}</span> : null}
              </dd>
              <dt>Last updated</dt>
              <dd>
                <CalendarClock aria-hidden className="cid-kv__glyph" />
                {catalogDetailTimestamp(updatedAt)}
                {updatedRelative ? <span className="cid-quiet"> · {updatedRelative}</span> : null}
              </dd>
            </dl>
          </ProvenanceStep>
        </ol>
      </CardBody>
    </Card>
  );
}
