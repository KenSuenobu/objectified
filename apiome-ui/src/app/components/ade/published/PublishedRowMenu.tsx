'use client';

/**
 * A published row's overflow menu, with its View fly-out (HIVE-8.1, #5327).
 *
 * Authority: `docs/mockups/ship/published.html` §Row kebab menu — *View ▸ (OpenAPI · Arazzo ·
 * JSON Schema) · Swagger UI · Copy URL · —— · Make Private/Public*, with the three viewers
 * inert and explained when the revision is private and the workspace holds no API key.
 *
 * ### What this replaces
 *
 * A `position: fixed` panel whose coordinates the screen measured off the trigger's bounding
 * box on every click, a full-screen `<div>` click-catcher above it, a nested panel opened on
 * `mouseenter` and closed on `mouseleave` — so the fly-out was unreachable from the keyboard
 * and vanished if the pointer crossed the gap between the two panels — and three copies of the
 * same tooltip string. It is a Radix `DropdownMenu` with a real `Sub` now, which brings the
 * placement and collision handling, the focus trap, `→`/`←` into and out of the fly-out,
 * `Escape`, and the `menu` / `menuitem` roles the old markup never had.
 *
 * ### What it decides
 *
 * Nothing. Which viewers are inert and why is `publishedViewItems`, and the rest of the list
 * is `publishedRowMenuItems`; both live in `publishedModel` where they are tested as data.
 * This maps an id to a glyph and hands the chosen id back to the screen.
 */

import * as React from 'react';
import * as DropdownMenu from '@radix-ui/react-dropdown-menu';
import {
  Braces,
  ChevronLeft,
  Copy,
  Ellipsis,
  Eye,
  FileJson2,
  Globe,
  Lock,
  PanelTop,
  Workflow,
} from 'lucide-react';

import { Button } from '@/app/components/ui/Button';
import { cn } from '@lib/utils';

import {
  publishedRowLabel,
  publishedRowMenuItems,
  publishedViewItems,
  type PublishedRowAction,
  type PublishedRowMenuContext,
  type PublishedVersion,
  type PublishedViewKind,
} from './publishedModel';

/** The glyph each fly-out entry carries. */
const VIEW_ICON: Readonly<Record<PublishedViewKind, React.ComponentType<{ className?: string }>>> = {
  openapi: FileJson2,
  arazzo: Workflow,
  json: Braces,
  swagger: PanelTop,
};

export interface PublishedRowMenuProps {
  /** The row. */
  version: PublishedVersion;
  /** Everything the menu's rules need beyond the row. */
  context: PublishedRowMenuContext;
  /** Called with the chosen action. */
  onAction: (action: PublishedRowAction, version: PublishedVersion) => void;
  /** True while this row's visibility write is in flight — the trigger goes inert. */
  busy?: boolean;
}

/**
 * Render one row's kebab and its menu. See {@link PublishedRowMenuProps}.
 *
 * @returns The trigger and its portalled menu.
 */
export function PublishedRowMenu({
  version,
  context,
  onAction,
  busy = false,
}: PublishedRowMenuProps) {
  const viewItems = React.useMemo(
    () => publishedViewItems(version, context),
    [version, context]
  );
  const items = React.useMemo(() => publishedRowMenuItems(version), [version]);
  const label = publishedRowLabel(version);

  return (
    <DropdownMenu.Root>
      <DropdownMenu.Trigger asChild>
        <Button
          variant="ghost"
          size="sm"
          className="px-1.5"
          disabled={busy}
          aria-label={`Actions for ${label}`}
          title="Actions"
          data-testid={`published-row-menu-${version.id}`}
        >
          <Ellipsis aria-hidden />
        </Button>
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content
          className="tnt-menu pub-menu"
          sideOffset={4}
          align="end"
          collisionPadding={8}
          data-testid={`published-row-menu-content-${version.id}`}
        >
          <DropdownMenu.Sub>
            <DropdownMenu.SubTrigger
              className="tnt-menu__item pub-menu__item"
              data-testid={`published-row-view-${version.id}`}
            >
              <Eye aria-hidden />
              View
              <ChevronLeft className="pub-menu__chevron" aria-hidden />
            </DropdownMenu.SubTrigger>
            <DropdownMenu.Portal>
              <DropdownMenu.SubContent
                className="tnt-menu pub-menu pub-menu--flyout"
                sideOffset={4}
                collisionPadding={8}
                data-testid={`published-row-view-content-${version.id}`}
              >
                {viewItems.map((item) => {
                  const Icon = VIEW_ICON[item.id];
                  return (
                    <DropdownMenu.Item
                      key={item.id}
                      className="tnt-menu__item pub-menu__item"
                      disabled={item.disabled}
                      title={item.title}
                      data-testid={`published-row-action-${item.id}-${version.id}`}
                      onSelect={() => onAction(item.id, version)}
                    >
                      <Icon aria-hidden />
                      {item.label}
                    </DropdownMenu.Item>
                  );
                })}
              </DropdownMenu.SubContent>
            </DropdownMenu.Portal>
          </DropdownMenu.Sub>

          {items.map((item) => {
            const Icon =
              item.id === 'swagger'
                ? VIEW_ICON.swagger
                : item.id === 'copy'
                  ? Copy
                  : version.visibility === 'public'
                    ? Lock
                    : Globe;
            return (
              <React.Fragment key={item.id}>
                {item.separatorBefore ? (
                  <DropdownMenu.Separator className="pub-menu__sep" />
                ) : null}
                <DropdownMenu.Item
                  className={cn(
                    'tnt-menu__item pub-menu__item',
                    item.id === 'visibility' && 'pub-menu__item--visibility'
                  )}
                  data-testid={`published-row-action-${item.id}-${version.id}`}
                  onSelect={() => onAction(item.id, version)}
                >
                  <Icon aria-hidden />
                  {item.label}
                </DropdownMenu.Item>
              </React.Fragment>
            );
          })}
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  );
}

export default PublishedRowMenu;
