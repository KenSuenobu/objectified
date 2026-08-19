'use client';

/**
 * One catalog item, as a card (HIVE-7.1, #5318).
 *
 * Authority: `docs/mockups/sources/catalog.html` §Cards view — the hex avatar, the name, the
 * mono `cat_xxxxx · slug` line, the status pill, the two-line summary, the dashed `fmt-slot`
 * holding format · protocol · source, the Quality / Lint / Debt orbs, the revision count, the
 * converted back-link, and the footer's `imported by …` / `updated …`; plus the amber
 * treatment with Undelete / Permanently delete for a card that needs attention.
 *
 * ### The whole card opens the item, and it is still one link
 *
 * The card this replaces made its body a `role="button"` with a `tabIndex` and then put real
 * buttons — two score orbs and an actions menu — inside it. That is `nested-interactive`, a
 * *serious* axe violation, and the ticket's definition of done asks for none.
 *
 * So the card is an `<article>` with no role of its own, and the item's **name** is the link.
 * `.cat-card__link::after` stretches that one link over the whole card, which is what gives
 * back the big hit area; every control that has to stay clickable sits on `.cat-card__above`,
 * one stacking step higher. One tab stop, one accessible name, the same pointer target — and
 * the orbs, the badge and the menu still work. The same fix `ProjectCard` made in HIVE-6.1,
 * for the same reason: this card was cloned from that one.
 *
 * A deleted item has no link at all: its detail page is hidden with it, so the card is inert
 * except for the two verbs in its footer.
 *
 * @see `./catalogModel.ts` — every figure and every string on this card.
 */

import * as React from 'react';
import Link from 'next/link';
import { ArrowLeftRight, Ellipsis, Eye, FileOutput, PanelsTopLeft, ScanLine, Trash2, Undo2 } from 'lucide-react';
import * as DropdownMenu from '@radix-ui/react-dropdown-menu';

import { Avatar } from '@/app/components/ui/Avatar';
import { Badge } from '@/app/components/ui/Badge';
import { Button } from '@/app/components/ui/Button';
import { Ring } from '@/app/components/ui/metrics';
import { formatRelativeTime } from '@/app/ade/dashboard/versions/version-history-dag';
import { CATALOG_EXPORT_VS_CONVERT_COPY, convertActionLabel } from '@/app/utils/catalog-conversion';
import type { ProjectQualitySnapshot } from '@/app/utils/project-quality-score-history';
import { cn } from '@lib/utils';

import { CatalogFormatRow, ConvertedBadge } from './CatalogBadges';
import {
  CATALOG_LIFECYCLE_LABEL,
  catalogItemHref,
  catalogLifecycle,
  catalogRowActions,
  catalogScores,
  catalogShortId,
  catalogSummaryText,
  catalogVersionsLabel,
  type CatalogItem,
} from './catalogModel';

/** The row-menu item class, shared with the tenants menu and the projects card. */
const MENU_ITEM_CLASS = 'tnt-menu__item';

/** The verbs a card and a row both offer, so the two menus cannot drift apart. */
export interface CatalogItemHandlers {
  /** Open the item's detail view. */
  onOpenDetail: (item: CatalogItem) => void;
  /** Open its revisions. */
  onOpenVersions: (item: CatalogItem) => void;
  /** Open the server-backed lint report. */
  onOpenLint: (item: CatalogItem) => void;
  /** Open the Export Studio scoped to it. */
  onExport: (item: CatalogItem) => void;
  /** Open the conversion preview. */
  onConvert: (item: CatalogItem) => void;
  /** Soft-delete it. */
  onDelete: (item: CatalogItem) => void;
  /** Restore a soft-deleted item. */
  onRestore: (item: CatalogItem) => void;
  /** Destroy it, after the type-to-confirm gate. */
  onPermanentDelete: (item: CatalogItem) => void;
}

export interface CatalogCardProps extends CatalogItemHandlers {
  /** The item this card is about. */
  item: CatalogItem;
  /** Its browser-local quality snapshots, oldest first. */
  qualityHistory?: readonly ProjectQualitySnapshot[];
  /** Open the quality dialog — the server lint report, or the local history. */
  onOpenQuality: (item: CatalogItem) => void;
  /** True while a write is in flight — every verb on the card goes inert. */
  busy?: boolean;
}

/**
 * Render one catalog card. See {@link CatalogCardProps}.
 *
 * @returns The card, or its amber variant when the item needs attention.
 */
export default function CatalogCard({
  item,
  qualityHistory = [],
  onOpenQuality,
  onOpenDetail,
  onOpenVersions,
  onOpenLint,
  onExport,
  onConvert,
  onDelete,
  onRestore,
  onPermanentDelete,
  busy = false,
}: CatalogCardProps) {
  const lifecycle = catalogLifecycle(item);
  const isDeleted = lifecycle === 'deleted';
  const scores = catalogScores(item, qualityHistory);
  const updated = formatRelativeTime(item.updated_at);

  return (
    <article
      className="cat-card"
      data-lifecycle={lifecycle}
      data-testid="catalog-card"
      data-catalog-id={item.id}
    >
      <div className="cat-card__body">
        <div className="cat-card__head">
          <Avatar shape="hex" size="lg" name={item.name} id={item.id} />
          <div className="cat-card__identity">
            <h3 className="cat-card__name">
              {isDeleted ? (
                item.name
              ) : (
                <Link href={catalogItemHref(item)} className="cat-card__link">
                  {item.name}
                </Link>
              )}
            </h3>
            <p className="cat-card__id mono" title={item.slug ?? item.id}>
              {catalogShortId(item.id)}
              {item.slug ? ` · ${item.slug}` : ''}
            </p>
          </div>
          <Badge status={lifecycle} dot data-testid="catalog-card-status">
            {CATALOG_LIFECYCLE_LABEL[lifecycle]}
          </Badge>
        </div>

        <p className="cat-card__summary">{catalogSummaryText(item)}</p>

        {/* The mockup's dashed `fmt-slot`: what this item *is*, above what it scores. */}
        <div className="cat-card__formats" data-testid="catalog-card-formats">
          <CatalogFormatRow item={item} />
        </div>

        <div className="cat-card__meter">
          <div className="cat-card__scores cat-card__above">
            <CatalogOrb
              label="Quality"
              title="Open quality score"
              onClick={scores.quality != null ? () => onOpenQuality(item) : undefined}
            >
              <Ring score={scores.quality} label="Quality score" size="sm" />
            </CatalogOrb>
            <CatalogOrb
              label="Lint"
              title="Open lint report"
              onClick={scores.grade ? () => onOpenLint(item) : undefined}
            >
              <Ring
                score={scores.quality}
                grade={scores.grade}
                display="grade"
                label="Lint grade"
                size="sm"
              />
            </CatalogOrb>
            <CatalogOrb label="Debt" title="Technical debt (not yet computed)">
              <Ring score={null} label="Technical debt" size="sm" />
            </CatalogOrb>
          </div>
          <span className="cat-card__versions mono" data-testid="catalog-card-versions">
            {catalogVersionsLabel(scores.versionsCount)}
          </span>
        </div>

        {item.conversion ? (
          <div className="cat-card__promotion cat-card__above">
            <ConvertedBadge conversion={item.conversion} />
          </div>
        ) : null}
      </div>

      {isDeleted ? (
        <footer className="cat-card__footer cat-card__above" data-testid="catalog-card-recovery">
          <Button variant="outline" size="sm" disabled={busy} onClick={() => onRestore(item)}>
            <Undo2 aria-hidden />
            Undelete
          </Button>
          <Button
            variant="danger-soft"
            size="sm"
            disabled={busy}
            onClick={() => onPermanentDelete(item)}
          >
            <Trash2 aria-hidden />
            Permanently delete
          </Button>
        </footer>
      ) : (
        <footer className="cat-card__footer">
          <span className="cat-card__creator">
            <Avatar
              size="xs"
              name={item.creator_name ?? '?'}
              id={item.creator_email || item.creator_id || item.id}
            />
            <span className="cat-card__creator-name">
              imported by {item.creator_name || 'Unknown'}
            </span>
          </span>
          <span className="cat-card__stamp" title={item.updated_at}>
            {updated ? `updated ${updated}` : '—'}
          </span>
        </footer>
      )}

      {isDeleted ? null : (
        <div className="cat-card__actions cat-card__above">
          <CatalogRowMenu
            item={item}
            busy={busy}
            testId={`catalog-card-menu-${item.id}`}
            onOpenDetail={onOpenDetail}
            onOpenVersions={onOpenVersions}
            onOpenLint={onOpenLint}
            onExport={onExport}
            onConvert={onConvert}
            onDelete={onDelete}
            onRestore={onRestore}
            onPermanentDelete={onPermanentDelete}
          />
        </div>
      )}
    </article>
  );
}

/** Props for {@link CatalogOrb}. */
interface CatalogOrbProps {
  /** What the orb scores — `Quality`, `Lint`, `Debt`. */
  label: string;
  /** The tooltip, which is also the button's title when it has one. */
  title: string;
  /** What opening it does. Absent for an orb with nothing behind it, which is not a button. */
  onClick?: () => void;
  /** The `<Ring>` itself. */
  children: React.ReactNode;
}

/**
 * One of the card's three orbs: the ring and the word under it.
 *
 * An orb with no score is a `<span>`, never a disabled button. "Not measured" is a fact about
 * the item, and a control that is present but refuses to do anything is a worse way of saying
 * it than not being a control at all — the `<Ring>` already prints an em dash and announces
 * itself as unscored. Debt is *always* that span: technical debt is not computed yet, and the
 * mockup's own tooltip says so.
 *
 * @param props See {@link CatalogOrbProps}.
 * @returns The orb.
 */
function CatalogOrb({ label, title, onClick, children }: CatalogOrbProps) {
  const content = (
    <>
      {children}
      <span className="cat-orb__label">{label}</span>
    </>
  );

  if (!onClick) {
    return (
      <span className="cat-orb" title={title}>
        {content}
      </span>
    );
  }

  return (
    <button type="button" className="cat-orb cat-orb--action" title={title} onClick={onClick}>
      {content}
    </button>
  );
}

export interface CatalogRowMenuProps extends CatalogItemHandlers {
  /** The row this menu acts on. */
  item: CatalogItem;
  /** True while a write is in flight. */
  busy?: boolean;
  /** The trigger's `data-testid`, so the card's and the table's can differ. */
  testId: string;
}

/**
 * The overflow menu a card and a table row both open.
 *
 * One component, because the mockup's **Keeps (1:1)** list gives the two the same seven verbs
 * and the screen this replaces spelled them twice — 180 lines of hand-positioned `fixed`
 * dropdown with its own click-away overlay, `getBoundingClientRect` maths and a `z-10`
 * backdrop, which Radix's portal, collision handling and focus management already do.
 *
 * Which verbs appear is {@link catalogRowActions}, not a chain of `item.deleted_at ?` here.
 *
 * @param props See {@link CatalogRowMenuProps}.
 * @returns The trigger and its menu.
 */
export function CatalogRowMenu({
  item,
  busy = false,
  testId,
  onOpenDetail,
  onOpenVersions,
  onOpenLint,
  onExport,
  onConvert,
  onDelete,
  onRestore,
  onPermanentDelete,
}: CatalogRowMenuProps) {
  const actions = catalogRowActions(item);

  return (
    <DropdownMenu.Root>
      <DropdownMenu.Trigger asChild>
        <Button
          variant="ghost"
          size="sm"
          className="px-1.5"
          disabled={busy}
          aria-label={`Actions for ${item.name}`}
          data-testid={testId}
        >
          <Ellipsis aria-hidden />
        </Button>
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content className="tnt-menu" sideOffset={4} align="end">
          {actions.details ? (
            <DropdownMenu.Item className={MENU_ITEM_CLASS} onSelect={() => onOpenDetail(item)}>
              <PanelsTopLeft aria-hidden />
              Details
            </DropdownMenu.Item>
          ) : null}
          {actions.versions ? (
            <DropdownMenu.Item className={MENU_ITEM_CLASS} onSelect={() => onOpenVersions(item)}>
              <Eye aria-hidden />
              View versions
            </DropdownMenu.Item>
          ) : null}
          {actions.lint ? (
            <DropdownMenu.Item className={MENU_ITEM_CLASS} onSelect={() => onOpenLint(item)}>
              <ScanLine aria-hidden />
              Lint
            </DropdownMenu.Item>
          ) : null}
          {actions.export ? (
            <DropdownMenu.Item
              className={MENU_ITEM_CLASS}
              title={CATALOG_EXPORT_VS_CONVERT_COPY}
              data-testid="catalog-action-export"
              onSelect={() => onExport(item)}
            >
              <FileOutput aria-hidden />
              Export to another format…
            </DropdownMenu.Item>
          ) : null}
          {actions.convert ? (
            <DropdownMenu.Item
              className={MENU_ITEM_CLASS}
              data-testid="catalog-action-convert"
              onSelect={() => onConvert(item)}
            >
              <ArrowLeftRight aria-hidden />
              {convertActionLabel(item.conversion, item.sourceFormat)}
            </DropdownMenu.Item>
          ) : null}
          {actions.undelete ? (
            <DropdownMenu.Item className={MENU_ITEM_CLASS} onSelect={() => onRestore(item)}>
              <Undo2 aria-hidden />
              Undelete item
            </DropdownMenu.Item>
          ) : null}
          {actions.delete ? (
            <>
              <DropdownMenu.Separator className="tnt-menu__sep" />
              <DropdownMenu.Item
                className={cn(MENU_ITEM_CLASS, 'cat-menu__item--danger')}
                onSelect={() => onDelete(item)}
              >
                <Trash2 aria-hidden />
                Delete item
              </DropdownMenu.Item>
            </>
          ) : (
            <DropdownMenu.Separator className="tnt-menu__sep" />
          )}
          <DropdownMenu.Item
            className={cn(MENU_ITEM_CLASS, 'cat-menu__item--danger')}
            onSelect={() => onPermanentDelete(item)}
          >
            <Trash2 aria-hidden />
            Permanently delete
          </DropdownMenu.Item>
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  );
}
