'use client';

import * as React from 'react';
import * as DialogPrimitive from '@radix-ui/react-dialog';
import { Command, defaultFilter } from 'cmdk';
import { Search } from 'lucide-react';
import { Kbd } from '@/app/components/ui/Kbd';
import {
  Dialog,
  DialogDescription,
  DialogOverlay,
  DialogPortal,
  DialogTitle,
} from '@/app/components/ui/Dialog';
import { ICON_SIZE, ICON_STROKE_WIDTH } from '@/app/components/ui/iconSizes';
import { resolvePlatformNavIcon } from '@lib/platform-nav-icons';
import {
  COMMANDS_ONLY_PREFIX,
  parseCommandQuery,
  type PaletteCommand,
  type PaletteCommandGroup,
} from './commandPaletteModel';

/**
 * The command palette (HIVE-3.6, #5292).
 *
 * Authority: `docs/mockups/DESIGN.md` §5.4 (*640 px, groups Jump to · Actions · Recent,
 * typeahead, `>` for commands*) and `docs/mockups/assets/hive.css` §15 (`.palette`).
 *
 * This component draws the dialog and nothing else. What is *in* it comes from
 * `commandPaletteModel.ts`, and who opens it comes from `commandPaletteBus.ts` by way of
 * `CommandPaletteHost` — so the two questions a palette raises that have nothing to do with
 * pixels (which destinations exist, and which are gated) are answered where they can be
 * tested without a DOM.
 *
 * ### Why Radix's dialog around cmdk's list, rather than `Command.Dialog`
 *
 * `cmdk` ships its own dialog, but it labels the surface with `aria-label` and renders no
 * `DialogTitle` — which Radix 1.1 reports as an error, and which leaves the palette
 * *labelled* but not *described*. Composing the two gives the announcement `DESIGN.md` §9
 * asks for (a dialog with a name and a one-line description, both visually hidden because
 * the input beneath them says the same thing to a sighted reader) while keeping cmdk's
 * combobox/listbox semantics on the search and the results.
 *
 * ### Keyboard
 *
 * | Key | What happens | Owner |
 * | --- | --- | --- |
 * | `↑` `↓` | move the active row | cmdk |
 * | `↵` | open the active row | cmdk → {@link CommandPaletteProps.onSelect} |
 * | `tab` | switch to the Actions group | here — it is what the footer legend promises |
 * | `Esc` | close and restore focus | Radix |
 *
 * Tab is the only one of those that is not a browser default, and it is bound because the
 * palette's footer says it is. It is safe to take: the dialog's focus trap holds exactly one
 * focusable element — the input — so Tab has nowhere else to go, and `Esc` (not Tab) is what
 * a reader uses to leave a modal.
 */

/** Props for {@link CommandPalette}. */
export interface CommandPaletteProps {
  /** Whether the palette is open. */
  open: boolean;
  /** Called when the palette wants to close — `Esc`, the scrim, or a chosen row. */
  onOpenChange: (open: boolean) => void;
  /**
   * What to offer, already narrowed by the mode.
   *
   * The host rebuilds these from {@link parseCommandQuery}'s `commandsOnly` flag, so `>`
   * removes the Jump to and Recent groups outright rather than filtering them to nothing.
   */
  groups: readonly PaletteCommandGroup[];
  /** The current input value, owned by the host so a caller can open with one. */
  query: string;
  /** Called on every keystroke in the search field. */
  onQueryChange: (query: string) => void;
  /** Called when a row is chosen. The host closes, records and navigates. */
  onSelect: (command: PaletteCommand) => void;
}

/**
 * The search field's placeholder.
 *
 * It names what the palette can actually do. The mockup's placeholder also promises project
 * and catalog search, which is a later ticket's data — a placeholder that offers a search
 * the palette does not perform is a bug report waiting to be filed.
 */
const PLACEHOLDER = 'Search or jump to… or type a command';

/** The dialog's accessible name. */
const PALETTE_TITLE = 'Command palette';

/** Its one-line description, read after the name. */
const PALETTE_DESCRIPTION =
  'Search for a section to jump to, run a command, or reopen something recent. ' +
  'Type a greater-than sign to see commands only.';

/**
 * One row of the palette.
 *
 * A disabled row keeps its place and states its reason in the meta line rather than in a
 * `title`: a tooltip is not reachable from the keyboard, and this is a keyboard surface.
 * cmdk skips `aria-disabled` rows when the arrows move, so the reason is readable without
 * the row ever becoming a dead end.
 *
 * @param props.command The row to draw.
 * @param props.onSelect Called when the row is chosen.
 * @returns The `role="option"` row.
 */
function CommandRow({
  command,
  onSelect,
}: {
  command: PaletteCommand;
  onSelect: (command: PaletteCommand) => void;
}) {
  // A lookup, not a component definition — `React.createElement` is the honest spelling
  // (the same reason `RailNav` uses it).
  const icon = React.createElement(resolvePlatformNavIcon(command.icon), {
    size: ICON_SIZE.dense,
    strokeWidth: ICON_STROKE_WIDTH,
    'aria-hidden': true,
    className: 'palette__item-icon shrink-0',
  } as React.ComponentProps<'svg'>);

  return (
    <Command.Item
      value={command.id}
      keywords={[...command.keywords]}
      disabled={command.disabled}
      onSelect={() => onSelect(command)}
      className="palette__item"
      data-testid={`palette-item-${command.id}`}
    >
      {icon}
      <span className="palette__item-label truncate">{command.label}</span>
      {command.meta && <span className="palette__item-meta truncate">{command.meta}</span>}
      {command.keys && (
        <span className="palette__item-keys">
          <Kbd keys={command.keys} />
        </span>
      )}
    </Command.Item>
  );
}

/**
 * The command palette.
 *
 * @param props See {@link CommandPaletteProps}.
 * @returns The dialog, or nothing while it is closed (Radix keeps a closed dialog unmounted).
 */
export default function CommandPalette({
  open,
  onOpenChange,
  groups,
  query,
  onQueryChange,
  onSelect,
}: CommandPaletteProps) {
  const { commandsOnly, search } = parseCommandQuery(query);

  /** The dialog surface, so the open handler can reach the search field inside it. */
  const contentRef = React.useRef<HTMLDivElement | null>(null);

  /**
   * What had focus before the palette opened, so `Esc` can give it back.
   *
   * Captured in a *layout* effect, which is what makes it the trigger rather than the
   * palette's own input: React runs every layout effect before any passive one, and Radix
   * moves focus into the dialog from a passive effect. It is restored from
   * `onCloseAutoFocus` rather than left to Radix, so the behaviour is this component's
   * rather than a property of whichever version of the library is underneath — the same
   * call `PreferencesDrawerHost` makes.
   */
  const previouslyFocused = React.useRef<HTMLElement | null>(null);
  const wasOpen = React.useRef(false);
  React.useLayoutEffect(() => {
    if (open && !wasOpen.current) {
      const active = document.activeElement;
      previouslyFocused.current = active instanceof HTMLElement ? active : null;
    }
    wasOpen.current = open;
  }, [open]);

  /**
   * Score a row against what the reader means, not against what they typed.
   *
   * cmdk hands the filter the raw input, which in commands mode still carries the `>`; left
   * alone it would score every command against a character none of them contain and empty
   * the list the prefix was meant to reveal.
   */
  const filter = React.useCallback((value: string, raw: string, keywords?: string[]) => {
    const needle = parseCommandQuery(raw).search;
    if (!needle) return 1;
    return defaultFilter(value, needle, keywords);
  }, []);

  /**
   * Tab switches to the Actions group, as the footer legend says it does; shift+tab (or Tab
   * again) comes back. It is a toggle rather than a one-way move because the legend names
   * one key and a reader who overshoots needs the way back to be the key they just pressed.
   */
  const onKeyDown = React.useCallback(
    (event: React.KeyboardEvent<HTMLDivElement>) => {
      if (event.key !== 'Tab') return;
      event.preventDefault();

      if (commandsOnly || event.shiftKey) {
        onQueryChange(search);
        return;
      }
      onQueryChange(`${COMMANDS_ONLY_PREFIX} ${search}`.trimEnd());
    },
    [commandsOnly, onQueryChange, search]
  );

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogPortal>
        <DialogOverlay />
        <DialogPrimitive.Content
          className="palette"
          data-testid="command-palette"
          ref={contentRef}
          // The palette *is* its input: Radix would focus the first focusable child anyway,
          // and saying so here keeps that true if a control is ever added above it.
          onOpenAutoFocus={(event) => {
            event.preventDefault();
            contentRef.current?.querySelector('input')?.focus();
          }}
          onCloseAutoFocus={(event) => {
            event.preventDefault();
            const trigger = previouslyFocused.current;
            previouslyFocused.current = null;
            // The trigger can be gone: choosing a destination navigates, and the page the
            // palette was opened from may not be on screen any more.
            if (trigger?.isConnected) trigger.focus();
          }}
        >
          <DialogTitle className="sr-only">{PALETTE_TITLE}</DialogTitle>
          <DialogDescription className="sr-only">{PALETTE_DESCRIPTION}</DialogDescription>

          <Command
            label={PALETTE_TITLE}
            filter={filter}
            onKeyDown={onKeyDown}
            // Looping is what makes `↑` from the first row reach the last one, which on a
            // list this short is the fastest way to the bottom.
            loop
          >
            <div className="palette__input">
              <Search
                size={ICON_SIZE.rail}
                strokeWidth={ICON_STROKE_WIDTH}
                aria-hidden
                className="shrink-0"
              />
              <Command.Input
                value={query}
                onValueChange={onQueryChange}
                placeholder={PLACEHOLDER}
                data-testid="palette-input"
              />
              <Kbd>esc</Kbd>
            </div>

            <Command.List className="palette__list">
              <Command.Empty className="palette__empty">
                Nothing matches {search ? `“${search}”` : 'that'}.
              </Command.Empty>

              {groups.map((group) => (
                <Command.Group
                  key={group.id}
                  heading={group.heading}
                  className="palette__group"
                  data-testid={`palette-group-${group.id}`}
                >
                  {group.commands.map((command) => (
                    <CommandRow key={command.id} command={command} onSelect={onSelect} />
                  ))}
                </Command.Group>
              ))}
            </Command.List>

            {/* The legend of `DESIGN.md` §5.4. `Kbd` is decorative, so each hint spells its
                chord in words beside the chips for a reader who cannot see them. */}
            <div className="palette__foot">
              <span>
                <Kbd keys={['↑', '↓']} />
                <span className="sr-only">Up or down arrow: </span>
                navigate
              </span>
              <span>
                <Kbd>↵</Kbd>
                <span className="sr-only">Enter: </span>
                open
              </span>
              <span>
                <Kbd>tab</Kbd>
                <span className="sr-only">Tab: </span>
                actions
              </span>
              <span className="palette__foot-end">
                Type <Kbd>{COMMANDS_ONLY_PREFIX}</Kbd>
                <span className="sr-only">a greater-than sign</span> for commands
              </span>
            </div>
          </Command>
        </DialogPrimitive.Content>
      </DialogPortal>
    </Dialog>
  );
}
