'use client';

/**
 * The published-versions table (HIVE-8.1, #5327).
 *
 * Authority: `docs/mockups/ship/published.html` §Table — *Project / Version · Visibility ·
 * Access URL · Mock · Published · actions*, with no sorting, no paging and no column filters,
 * exactly as the mockup's **Notes → Keeps (1:1)** list requires.
 *
 * ### What this replaces
 *
 * Six hand-written `<th>`s over `dashboardScreenClasses`, a `<tbody>` whose cells named
 * `text-indigo-600 dark:text-indigo-400`, `bg-blue-100 dark:bg-blue-900/30`, `bg-gray-50
 * dark:bg-gray-900` and `text-gray-500 dark:text-gray-400` inline, and three states — loading,
 * empty and search-miss — that were siblings of the table rather than part of it, so the
 * search box and the count sentence disappeared whenever one of them drew. It is
 * {@link DataTable} now: the card, the sticky caps header, the skeleton shaped like the
 * content, the roving Tab stop and the in-card empty state all come with it.
 *
 * ### The cells this keeps 1:1
 *
 * The bold project name over the mono accent version label, the Locked chip, the truncated
 * description, the clickable visibility badge with its *Click to change to…* tooltip and its
 * in-flight disabled state, the `schema/{tenant}/{project}/{version}` access path, the
 * `VersionMockCell` (unchanged — the same component Build → Versions draws), and the
 * `MM/DD/YY hh:mm AM` stamp over *by {creator}*.
 *
 * ### The two things it adds
 *
 * The Deprecated pill on a sunsetting row, which links to the sunset timeline where the rest
 * of that story lives; and a copyable Access URL. The screen this replaces tracked a
 * `copiedUrl` state, reset it after two seconds, and never rendered anything from it — the
 * only way to copy an access URL was the kebab, and nothing on screen ever confirmed it.
 *
 * @see `./publishedModel.ts` — every rule these cells draw.
 */

import * as React from 'react';
import Link from 'next/link';
import { Check, Copy, Globe, KeyRound, Lock } from 'lucide-react';

import { Badge, badgeVariants } from '@/app/components/ui/Badge';
import { Button } from '@/app/components/ui/Button';
import {
  DataTable,
  DataTableCellPrimary,
  DataTableCellSub,
  type DataTableColumn,
} from '@/app/components/ui/DataTable';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/app/components/ui/Tooltip';
import { VersionMockCell, type VersionMockChange } from '@/app/components/ade/dashboard/VersionMockCell';
import { formatVersionStamp, versionLabel } from '@/app/components/ade/versions/versionsModel';
import { mockUsageSeriesKey } from '@/app/utils/mock-usage-series';
import { cn } from '@lib/utils';

import { PublishedRowMenu } from './PublishedRowMenu';
import {
  PUBLISHED_LOADING_LABEL,
  PUBLISHED_LOAD_ERROR,
  SUNSET_TIMELINE_HREF,
  publishedAccessLabel,
  publishedLifecyclePill,
  publishedRowLabel,
  visibilityToggleTooltip,
  type PublishedRowAction,
  type PublishedRowMenuContext,
  type PublishedVersion,
} from './publishedModel';

export interface PublishedTableProps {
  /** The rows to draw, already filtered. */
  versions: readonly PublishedVersion[];
  /** True until the first read has landed. */
  loading?: boolean;
  /** What went wrong with the read, or `null`. */
  error?: string | null;
  /** Read the list again. */
  onRetry?: () => void;
  /** Everything the row menu's rules need beyond the row. */
  menuContext: PublishedRowMenuContext;
  /** The row whose visibility write is in flight, or `null`. */
  changingVisibility: string | null;
  /** The row whose access URL was just copied, or `null`. */
  copiedVersionId: string | null;
  /** Where the hosted mock is served from, per row; `null` when the URL cannot be built. */
  mockBaseUrl: (version: PublishedVersion) => string | null;
  /** 30-day mock usage keyed by `mockUsageSeriesKey(slug, version_id)`; `null` while loading. */
  mockUsageByVersion: ReadonlyMap<string, readonly number[]> | null;
  /** Fold a mock toggle round-trip back into the row. */
  onMockChanged: (versionRecordId: string, change: VersionMockChange) => void;
  /** The visibility badge was clicked. */
  onToggleVisibility: (version: PublishedVersion) => void;
  /** The access URL was clicked. */
  onCopyAccessUrl: (version: PublishedVersion) => void;
  /** A row action was chosen — from the key button or the kebab. */
  onRowAction: (action: PublishedRowAction, version: PublishedVersion) => void;
  /** The toolbar the screen composes; passed through to {@link DataTable}. */
  toolbar?: React.ReactNode;
  /** The foot the screen composes. */
  footer?: React.ReactNode;
  /** What to draw when there are no rows. */
  empty?: React.ReactNode;
  /** The table's accessible name. */
  caption?: string;
}

/**
 * Render the published-versions table. See {@link PublishedTableProps}.
 *
 * @returns The table card, its toolbar and its foot.
 */
export function PublishedTable({
  versions,
  loading = false,
  error = null,
  onRetry,
  menuContext,
  changingVisibility,
  copiedVersionId,
  mockBaseUrl,
  mockUsageByVersion,
  onMockChanged,
  onToggleVisibility,
  onCopyAccessUrl,
  onRowAction,
  toolbar,
  footer,
  empty,
  caption = 'Published versions',
}: PublishedTableProps) {
  const columns = React.useMemo<DataTableColumn<PublishedVersion>[]>(
    () => [
      {
        id: 'version',
        header: 'Project / Version',
        className: 'pub-col-version',
        headerClassName: 'pub-col-version',
        cell: (version) => <VersionCell version={version} />,
        skeletonWidth: '11rem',
      },
      {
        id: 'visibility',
        header: 'Visibility',
        className: 'pub-col-visibility',
        headerClassName: 'pub-col-visibility',
        cell: (version) => (
          <VisibilityToggle
            version={version}
            busy={changingVisibility === version.id}
            onToggle={() => onToggleVisibility(version)}
          />
        ),
        skeletonWidth: '4.5rem',
      },
      {
        id: 'access',
        header: 'Access URL',
        className: 'pub-col-access',
        headerClassName: 'pub-col-access',
        cell: (version) => (
          <AccessUrlCell
            version={version}
            copied={copiedVersionId === version.id}
            onCopy={() => onCopyAccessUrl(version)}
          />
        ),
        skeletonWidth: '13rem',
      },
      {
        id: 'mock',
        header: 'Mock',
        className: 'pub-col-mock',
        headerClassName: 'pub-col-mock',
        cell: (version) => (
          <VersionMockCell
            versionRecordId={version.id}
            projectId={version.project_id}
            versionLabel={version.version_id}
            published
            mockEnabled={Boolean(version.mock_enabled)}
            mockBaseUrl={version.mock_enabled ? mockBaseUrl(version) : null}
            usageSeries={
              mockUsageByVersion === null
                ? undefined
                : (mockUsageByVersion.get(
                    mockUsageSeriesKey(version.project_slug, version.version_id)
                  ) ?? [])
            }
            onMockChanged={(change) => onMockChanged(version.id, change)}
          />
        ),
        skeletonWidth: '7rem',
      },
      {
        id: 'published',
        header: 'Published',
        className: 'pub-col-published',
        headerClassName: 'pub-col-published',
        cell: (version) => (
          <span className="pub-stamp">
            {formatVersionStamp(version.published_at)}
            <span className="pub-stamp__author">by {version.creator_name || 'unknown'}</span>
          </span>
        ),
        skeletonWidth: '6.5rem',
      },
      {
        id: 'actions',
        headerLabel: 'Actions',
        actions: true,
        className: 'pub-col-actions',
        headerClassName: 'pub-col-actions',
        cell: (version) => (
          <>
            {version.visibility === 'private' ? (
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    variant="ghost"
                    size="sm"
                    className="px-1.5"
                    aria-label={`API key required for ${publishedRowLabel(version)}`}
                    data-testid={`published-row-key-${version.id}`}
                    onClick={() => onRowAction('key', version)}
                  >
                    <KeyRound aria-hidden />
                  </Button>
                </TooltipTrigger>
                <TooltipContent>Private — needs an API key</TooltipContent>
              </Tooltip>
            ) : null}
            <PublishedRowMenu
              version={version}
              context={menuContext}
              onAction={onRowAction}
              busy={changingVisibility === version.id}
            />
          </>
        ),
        skeletonWidth: '4rem',
      },
    ],
    [
      changingVisibility,
      copiedVersionId,
      menuContext,
      mockBaseUrl,
      mockUsageByVersion,
      onCopyAccessUrl,
      onMockChanged,
      onRowAction,
      onToggleVisibility,
    ]
  );

  return (
    <DataTable
      className="pub-table"
      caption={caption}
      columns={columns}
      rows={versions}
      getRowId={(version) => version.id}
      getRowLabel={publishedRowLabel}
      scrollX
      loading={loading}
      loadingLabel={PUBLISHED_LOADING_LABEL}
      error={error}
      errorTitle={PUBLISHED_LOAD_ERROR}
      onRetry={onRetry}
      empty={empty}
      toolbar={toolbar}
      footer={footer}
      data-testid="published-table"
    />
  );
}

/** Props for {@link VersionCell}. */
interface VersionCellProps {
  /** The row. */
  version: PublishedVersion;
}

/**
 * The first cell: the project, the version label, its chips and the revision note.
 *
 * Every published revision is immutable (#2586), so the Locked chip is unconditional — it is
 * a statement about what the reader is looking at, not a per-row state. The lifecycle pill
 * beside it is the opposite: it appears only when a revision is *not* stable, and links to the
 * sunset timeline, which is where a deprecated revision's sunset, successor and migration
 * guide live.
 *
 * @param props See {@link VersionCellProps}.
 * @returns The cell contents.
 */
function VersionCell({ version }: VersionCellProps) {
  const pill = publishedLifecyclePill(version);
  return (
    <div className="pub-version">
      <DataTableCellPrimary>{version.project_name}</DataTableCellPrimary>
      <div className="pub-version__chips">
        <span className="pub-version__label mono">{versionLabel(version)}</span>
        <Badge status="locked" title="Published revisions are immutable">
          <Lock aria-hidden />
          Locked
        </Badge>
        {pill ? (
          <Link
            href={SUNSET_TIMELINE_HREF}
            className="pub-version__lifecycle"
            title={pill.title}
            data-testid={`published-lifecycle-${version.id}`}
          >
            <Badge status={pill.lifecycle}>{pill.label}</Badge>
          </Link>
        ) : null}
      </div>
      {version.description ? (
        <DataTableCellSub className="pub-version__desc" title={version.description}>
          {version.description}
        </DataTableCellSub>
      ) : null}
    </div>
  );
}

/** Props for {@link VisibilityToggle}. */
interface VisibilityToggleProps {
  /** The row. */
  version: PublishedVersion;
  /** True while this row's write is in flight. */
  busy: boolean;
  /** Ask for the change. */
  onToggle: () => void;
}

/**
 * The visibility badge, which is also the control that changes it.
 *
 * The badge *is* the button rather than a `<div>` wrapped in one: a `Badge` renders a `div`,
 * which is flow content and not allowed inside `<button>`, so the old markup was invalid where
 * it mattered most — the one interactive cell on the row. `badgeVariants` gives the button the
 * same chrome from the same source, and `data-status` keeps the vocabulary attribute a test or
 * a stylesheet can still find.
 *
 * While a change is in flight the button is `disabled` and `aria-busy`, which is the
 * acceptance criterion *"the toggle disables while the change is in flight"*. A failure leaves
 * the row exactly where it was and raises the screen's error banner — nothing here has to
 * remember an optimistic state, because there is not one.
 *
 * @param props See {@link VisibilityToggleProps}.
 * @returns The toggle.
 */
function VisibilityToggle({ version, busy, onToggle }: VisibilityToggleProps) {
  const isPublic = version.visibility === 'public';
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        {/* A disabled button is not hoverable, so the span keeps the tooltip reachable. */}
        <span className="pub-visibility">
          <button
            type="button"
            data-status={version.visibility}
            className={cn(
              badgeVariants({ variant: isPublic ? 'ok' : 'violet' }),
              'pub-visibility__button'
            )}
            disabled={busy}
            aria-busy={busy || undefined}
            aria-label={`Visibility: ${version.visibility}. ${visibilityToggleTooltip(version)}`}
            data-testid={`published-visibility-${version.id}`}
            onClick={onToggle}
          >
            {isPublic ? <Globe aria-hidden /> : <Lock aria-hidden />}
            {isPublic ? 'Public' : 'Private'}
          </button>
        </span>
      </TooltipTrigger>
      <TooltipContent>{visibilityToggleTooltip(version)}</TooltipContent>
    </Tooltip>
  );
}

/** Props for {@link AccessUrlCell}. */
interface AccessUrlCellProps {
  /** The row. */
  version: PublishedVersion;
  /** True for the two seconds after this row's URL was copied. */
  copied: boolean;
  /** Copy the absolute URL. */
  onCopy: () => void;
}

/**
 * The Access URL cell — the printed path, and the click that copies the absolute URL.
 *
 * The copied state is a glyph swap and a tint for `COPIED_URL_RESET_MS`, announced by
 * the screen's toast rather than by a live region in the cell: an `sr-only` element inside a
 * `<td>` is positioned against the *initial* containing block, not against the table's scroll
 * wrapper, and drags the document's scroll width sideways at narrow viewports (the finding
 * HIVE-7.3 recorded). The toast is already a live region and says the same thing.
 *
 * @param props See {@link AccessUrlCellProps}.
 * @returns The cell contents.
 */
function AccessUrlCell({ version, copied, onCopy }: AccessUrlCellProps) {
  const label = publishedAccessLabel(version);
  return (
    <button
      type="button"
      className="pub-url"
      data-copied={copied || undefined}
      aria-label={`Copy access URL for ${publishedRowLabel(version)}`}
      title={label}
      data-testid={`published-access-url-${version.id}`}
      onClick={onCopy}
    >
      <code className="pub-url__code mono">{label}</code>
      {copied ? (
        <Check className="pub-url__glyph" aria-hidden />
      ) : (
        <Copy className="pub-url__glyph" aria-hidden />
      )}
    </button>
  );
}

export default PublishedTable;
