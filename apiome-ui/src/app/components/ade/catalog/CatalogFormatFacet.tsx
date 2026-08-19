'use client';

/**
 * The format facet (MFI-28.4; rebuilt HIVE-7.1, #5318).
 *
 * Authority: `docs/mockups/sources/catalog.html` §Toolbar — a `Format` button carrying the
 * count of ticked families, opening a menu headed *Formats* with a *Clear* beside it.
 *
 * Format is the Catalog's defining axis, so this is the one filter that is multi-select: a
 * reader comparing their GraphQL and their gRPC surfaces wants both, and picking one at a
 * time would make that two passes over the list.
 *
 * ### What changed, and why it is not a rewrite of behaviour
 *
 * The control this replaces was a hand-built `<div role="listbox">` with its own
 * `document.addEventListener('mousedown')` click-away, its own Escape handler, its own
 * absolutely-positioned panel and hand-drawn check squares — none of which handled collision
 * with the viewport edge, focus restoration or typeahead. It is a Radix
 * `DropdownMenu.CheckboxItem` list now, on the shared `.tnt-menu` chrome, so it behaves like
 * the other six menus on this screen. The *contract* is unchanged: fully controlled, an empty
 * selection means "every format", and the options come from the page.
 *
 * The options now carry a **count**, which is the ticket's acceptance criterion: the count is
 * how many rows every *other* control has left that carry this family, so a checkbox says
 * what ticking it would show. See `catalogFormatFacetOptions`.
 */

import * as React from 'react';
import * as DropdownMenu from '@radix-ui/react-dropdown-menu';
import { Check, ChevronDown, Layers, X } from 'lucide-react';

import { Button } from '@/app/components/ui/Button';

import type { CatalogFormatFacetOption } from './catalogModel';

export interface CatalogFormatFacetProps {
  /** The families present in the current list, with their counts, from the page. */
  options: readonly CatalogFormatFacetOption[];
  /** The currently ticked family ids. Empty means "all formats" (no filtering). */
  selected: readonly string[];
  /** Report the next selection (the full next set of ids) to the page. */
  onChange: (next: string[]) => void;
}

/**
 * Render the facet button and its menu. See {@link CatalogFormatFacetProps}.
 *
 * @returns The trigger, and the menu when there is anything to filter by.
 */
export function CatalogFormatFacet({ options, selected, onChange }: CatalogFormatFacetProps) {
  const ticked = React.useMemo(() => new Set(selected), [selected]);
  const hasOptions = options.length > 0;

  const toggle = React.useCallback(
    (id: string) => {
      const next = new Set(ticked);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      onChange([...next]);
    },
    [onChange, ticked]
  );

  const trigger = (
    <Button
      variant="outline"
      size="sm"
      className="cat-facet__trigger"
      disabled={!hasOptions}
      data-testid="catalog-format-facet"
      data-active={ticked.size > 0 ? '' : undefined}
      title={hasOptions ? 'Filter by format' : 'No formats to filter yet'}
    >
      <Layers aria-hidden />
      Format
      {ticked.size > 0 ? (
        <span className="cat-facet__count" data-testid="catalog-format-facet-count">
          {ticked.size}
        </span>
      ) : null}
      <ChevronDown aria-hidden />
    </Button>
  );

  // A disabled trigger cannot open anything, and Radix would still wire it up — so an empty
  // catalog gets the button on its own, with the reason in its title.
  if (!hasOptions) return trigger;

  return (
    <DropdownMenu.Root>
      <DropdownMenu.Trigger asChild>{trigger}</DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content
          className="tnt-menu cat-facet__menu"
          sideOffset={4}
          align="start"
          data-testid="catalog-format-facet-menu"
        >
          <DropdownMenu.Label className="cat-facet__head">
            <span className="cat-facet__title">Formats</span>
            {ticked.size > 0 ? (
              <button
                type="button"
                className="cat-facet__clear"
                data-testid="catalog-format-clear"
                onClick={() => onChange([])}
              >
                <X aria-hidden />
                Clear
              </button>
            ) : null}
          </DropdownMenu.Label>
          {options.map((option) => (
            <DropdownMenu.CheckboxItem
              key={option.id}
              className="tnt-menu__item cat-facet__option"
              checked={ticked.has(option.id)}
              data-testid={`catalog-format-option-${option.id}`}
              // The menu stays open: ticking one family and then another is one decision,
              // and a menu that closes after each tick makes a two-format filter four clicks.
              onSelect={(event) => {
                event.preventDefault();
                toggle(option.id);
              }}
            >
              <span className="cat-facet__box" aria-hidden>
                <DropdownMenu.ItemIndicator>
                  <Check />
                </DropdownMenu.ItemIndicator>
              </span>
              <span className="cat-facet__label">{option.label}</span>
              <span className="cat-facet__n mono">{option.count}</span>
            </DropdownMenu.CheckboxItem>
          ))}
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  );
}

export default CatalogFormatFacet;
