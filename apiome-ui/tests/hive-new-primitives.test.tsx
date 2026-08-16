/**
 * The four new Hive primitives (HIVE-2.2, #5281).
 *
 * `Segmented`, `Drawer`, `Avatar` and `Kbd` are patterns the mockups repeat and production
 * had no equivalent for, so unlike the HIVE-2.1 re-token there is no "no consumer needs an
 * edit" promise to hold down — the contract is the behaviour each one is about to be relied
 * on for by Epics 3 and 5:
 *
 *   1. **Segmented is a radio group, not a tab strip.** One Tab stop, arrow keys that move
 *      *and* select, disabled options skipped, and a state assistive technology can read.
 *   2. **Drawer is Radix's Dialog with different geometry.** Focus trapped while open,
 *      restored on close, `Esc` dismissal, and a drawer opened over a dialog on top of it.
 *   3. **Avatar's colour is a function of the identity**, not of the call site — the same
 *      seed is the same tint on every surface and in every process.
 *   4. **Kbd is presentation only** — the chips are hidden from assistive technology, which
 *      is what makes the "Show keyboard hints" preference safe to honour in CSS alone.
 *
 * The stylesheet's half — the hexagon clip, the slide-in keyframes, the preference rule
 * that hides the chips — is `tests/hive-new-primitive-styles.test.ts`, because jsdom
 * compiles no CSS.
 */

import React from 'react';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import '@testing-library/jest-dom';
import { axe } from 'jest-axe';
import 'jest-axe/extend-expect';

import {
  AVATAR_TINTS,
  Avatar,
  AvatarStack,
  Button,
  Dialog,
  DialogContent,
  DialogTitle,
  Drawer,
  DrawerBody,
  DrawerClose,
  DrawerContent,
  DrawerDescription,
  DrawerFooter,
  DrawerHeader,
  DrawerOpenFullPageLink,
  DrawerTitle,
  DrawerTrigger,
  Kbd,
  Segmented,
  SegmentedItem,
  avatarInitials,
  avatarToneFor,
} from '../src/app/components/ui';

/** Every class on an element, as a set — order is meaningless, membership is not. */
function classesOf(element: Element): Set<string> {
  return new Set(element.className.split(/\s+/).filter(Boolean));
}

describe('Segmented — the view switch', () => {
  /** The three-option group used by most of the cases below. */
  function renderGroup(props: Partial<React.ComponentProps<typeof Segmented>> = {}) {
    return render(
      <Segmented aria-label="View" defaultValue="cards" {...props}>
        <SegmentedItem value="cards">Cards</SegmentedItem>
        <SegmentedItem value="table">Table</SegmentedItem>
        <SegmentedItem value="board" disabled>
          Board
        </SegmentedItem>
      </Segmented>
    );
  }

  it('is a named radio group of radios, with one selected', () => {
    renderGroup();
    expect(screen.getByRole('radiogroup', { name: 'View' })).toBeInTheDocument();
    expect(screen.getByRole('radio', { name: 'Cards' })).toBeChecked();
    expect(screen.getByRole('radio', { name: 'Table' })).not.toBeChecked();
  });

  it('holds exactly one Tab stop, on the selected option', () => {
    renderGroup();
    expect(screen.getByRole('radio', { name: 'Cards' })).toHaveAttribute('tabindex', '0');
    expect(screen.getByRole('radio', { name: 'Table' })).toHaveAttribute('tabindex', '-1');
    expect(screen.getByRole('radio', { name: 'Board' })).toHaveAttribute('tabindex', '-1');
  });

  it('puts the Tab stop on the first enabled option when nothing is selected', () => {
    render(
      <Segmented aria-label="Scope">
        <SegmentedItem value="mine" disabled>
          Mine
        </SegmentedItem>
        <SegmentedItem value="workspace">Workspace</SegmentedItem>
      </Segmented>
    );
    expect(screen.getByRole('radio', { name: 'Workspace' })).toHaveAttribute('tabindex', '0');
  });

  it('keeps a Tab stop when the value matches no option', () => {
    // A group whose `value` came from storage or a URL the options no longer answer to
    // would otherwise have no tabbable child at all, and the keyboard would step over it.
    renderGroup({ value: 'gone', defaultValue: undefined });
    expect(screen.getByRole('radio', { name: 'Cards' })).toHaveAttribute('tabindex', '0');
    expect(screen.getByRole('radio', { name: 'Cards' })).not.toBeChecked();
  });

  it('keeps every option reachable when the items are wrapped', async () => {
    // A caller may wrap an option — in a tooltip trigger, in a layout element — and the
    // roving `tabindex` cannot read a value through the wrapper. Rather than leave the
    // group with no Tab stop at all, every option keeps its own; arrow-key movement still
    // works, because that is driven from the DOM.
    render(
      <Segmented aria-label="View" defaultValue="cards">
        <span>
          <SegmentedItem value="cards">Cards</SegmentedItem>
        </span>
        <span>
          <SegmentedItem value="table">Table</SegmentedItem>
        </span>
      </Segmented>
    );
    expect(screen.getByRole('radio', { name: 'Cards' })).toHaveAttribute('tabindex', '0');
    expect(screen.getByRole('radio', { name: 'Table' })).toHaveAttribute('tabindex', '0');

    const user = userEvent.setup();
    await user.tab();
    await user.keyboard('{ArrowRight}');
    expect(screen.getByRole('radio', { name: 'Table' })).toBeChecked();
  });

  it.each([
    ['{ArrowRight}', 'Board', 'board'],
    ['{ArrowDown}', 'Board', 'board'],
    ['{ArrowLeft}', 'Cards', 'cards'],
    ['{ArrowUp}', 'Cards', 'cards'],
  ])('moves and selects with %s', async (key, expected, expectedValue) => {
    const onValueChange = jest.fn();
    // Three enabled options, starting in the middle, so forwards and backwards land in
    // different places and the direction is actually under test.
    render(
      <Segmented aria-label="View" defaultValue="table" onValueChange={onValueChange}>
        <SegmentedItem value="cards">Cards</SegmentedItem>
        <SegmentedItem value="table">Table</SegmentedItem>
        <SegmentedItem value="board">Board</SegmentedItem>
      </Segmented>
    );
    const user = userEvent.setup();
    await user.tab();
    expect(screen.getByRole('radio', { name: 'Table' })).toHaveFocus();

    await user.keyboard(key);

    expect(screen.getByRole('radio', { name: expected })).toHaveFocus();
    expect(screen.getByRole('radio', { name: expected })).toBeChecked();
    expect(onValueChange).toHaveBeenLastCalledWith(expectedValue);
  });

  it('wraps at the ends and skips disabled options', async () => {
    renderGroup();
    const user = userEvent.setup();
    await user.tab();
    // Cards → Table → back to Cards: `Board` is disabled, so it is never landed on.
    await user.keyboard('{ArrowRight}');
    expect(screen.getByRole('radio', { name: 'Table' })).toHaveFocus();
    await user.keyboard('{ArrowRight}');
    expect(screen.getByRole('radio', { name: 'Cards' })).toHaveFocus();
    expect(screen.getByRole('radio', { name: 'Board' })).not.toBeChecked();
  });

  it('jumps to the ends with Home and End', async () => {
    renderGroup();
    const user = userEvent.setup();
    await user.tab();
    await user.keyboard('{End}');
    // `End` is the last *enabled* option, because a disabled one cannot be selected.
    expect(screen.getByRole('radio', { name: 'Table' })).toBeChecked();
    await user.keyboard('{Home}');
    expect(screen.getByRole('radio', { name: 'Cards' })).toBeChecked();
  });

  it('ignores keys it does not own, so a caller can still handle them', async () => {
    const onKeyDown = jest.fn();
    renderGroup({ onKeyDown });
    const user = userEvent.setup();
    await user.tab();
    await user.keyboard('a');
    expect(onKeyDown).toHaveBeenCalled();
    expect(screen.getByRole('radio', { name: 'Cards' })).toBeChecked();
  });

  it('selects on click, and reports the value once', async () => {
    const onValueChange = jest.fn();
    renderGroup({ onValueChange });
    await userEvent.setup().click(screen.getByRole('radio', { name: 'Table' }));
    expect(onValueChange).toHaveBeenCalledTimes(1);
    expect(onValueChange).toHaveBeenCalledWith('table');
  });

  it('stays where a controlled caller puts it', async () => {
    const onValueChange = jest.fn();
    renderGroup({ value: 'cards', defaultValue: undefined, onValueChange });
    await userEvent.setup().click(screen.getByRole('radio', { name: 'Table' }));
    expect(onValueChange).toHaveBeenCalledWith('table');
    // The caller did not re-render with the new value, so the group must not move itself.
    expect(screen.getByRole('radio', { name: 'Cards' })).toBeChecked();
  });

  it('paints the track and the thumb from tokens', () => {
    renderGroup();
    const track = screen.getByRole('radiogroup');
    expect(classesOf(track)).toContain('bg-inset');

    const selected = screen.getByRole('radio', { name: 'Cards' });
    expect(selected).toHaveAttribute('data-state', 'on');
    expect(classesOf(selected)).toContain('data-[state=on]:bg-surface');
    expect(classesOf(selected)).toContain('data-[state=on]:shadow-[var(--shadow-raised)]');
    // Derived from the control metric, never frozen: the density and font-size
    // preferences reach the option through `--control-h`.
    expect(classesOf(selected)).toContain('h-[calc(var(--control-h)-0.5rem)]');
  });

  it('renders the sm option one step down', () => {
    render(
      <Segmented aria-label="Scope" size="sm" defaultValue="mine">
        <SegmentedItem value="mine">Mine</SegmentedItem>
      </Segmented>
    );
    const classes = classesOf(screen.getByRole('radio', { name: 'Mine' }));
    expect(classes).toContain('h-[calc(var(--control-h)-0.75rem)]');
    expect(classes).toContain('text-xs');
  });

  it('names the mistake when an option is used outside a group', () => {
    const consoleError = jest.spyOn(console, 'error').mockImplementation(() => {});
    expect(() => render(<SegmentedItem value="orphan">Orphan</SegmentedItem>)).toThrow(
      /must be rendered inside a <Segmented>/
    );
    consoleError.mockRestore();
  });

  it('is axe-clean', async () => {
    const { container } = renderGroup();
    expect(await axe(container)).toHaveNoViolations();
  });
});

describe('Drawer — the right side-sheet', () => {
  /** A drawer with a trigger, at the default width. */
  function renderDrawer(props: Partial<React.ComponentProps<typeof DrawerContent>> = {}) {
    return render(
      <Drawer>
        <DrawerTrigger asChild>
          <Button>Open drawer</Button>
        </DrawerTrigger>
        <DrawerContent {...props}>
          <DrawerHeader>
            <DrawerTitle>Audit event</DrawerTitle>
            <DrawerDescription>evt_9c1d</DrawerDescription>
          </DrawerHeader>
          <DrawerBody>
            <p>Ada Lovelace assigned a role.</p>
          </DrawerBody>
          <DrawerFooter>
            <DrawerOpenFullPageLink href="/ade/dashboard/audit/evt_9c1d" />
            <DrawerClose asChild>
              <Button variant="outline">Dismiss</Button>
            </DrawerClose>
          </DrawerFooter>
        </DrawerContent>
      </Drawer>
    );
  }

  it('opens from its trigger as a modal sheet, with the page behind it inert', async () => {
    const { baseElement } = renderDrawer();
    await userEvent.setup().click(screen.getByRole('button', { name: 'Open drawer' }));

    const sheet = await screen.findByRole('dialog', { name: 'Audit event' });
    expect(within(sheet).getByText('Ada Lovelace assigned a role.')).toBeInTheDocument();
    expect(within(sheet).getByText('evt_9c1d')).toBeInTheDocument();

    // Radix hides everything outside the overlay from assistive technology while it is
    // open — the modal half of "modal", and the reason the trigger is unreachable below.
    const page = baseElement.querySelector('div:not([data-radix-portal])');
    expect(page).toHaveAttribute('aria-hidden', 'true');
  });

  it('traps focus inside the sheet while it is open', async () => {
    renderDrawer();
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'Open drawer' }));
    const sheet = await screen.findByRole('dialog');

    await waitFor(() => expect(sheet.contains(document.activeElement)).toBe(true));

    // Tab all the way round: focus never leaves the sheet, which is the whole promise of
    // a modal overlay for a keyboard reader.
    for (let step = 0; step < 8; step += 1) {
      await user.tab();
      expect(sheet.contains(document.activeElement)).toBe(true);
    }
  });

  it('closes on Esc and gives focus back to the trigger', async () => {
    renderDrawer();
    const user = userEvent.setup();
    const trigger = screen.getByRole('button', { name: 'Open drawer' });
    await user.click(trigger);
    await screen.findByRole('dialog');

    await user.keyboard('{Escape}');

    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    await waitFor(() => expect(trigger).toHaveFocus());
  });

  it.each(['Dismiss', 'Close'])('closes from the %s action', async (name) => {
    // Two ways out, and both are `DrawerClose`: the footer action a caller writes, and the
    // corner button the sheet supplies.
    renderDrawer();
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'Open drawer' }));
    await screen.findByRole('dialog');
    await user.click(screen.getByRole('button', { name }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  });

  it('stacks over an open dialog and takes the focus with it', async () => {
    render(
      <Dialog defaultOpen>
        <DialogContent aria-describedby={undefined}>
          <DialogTitle>Publish version</DialogTitle>
          <Drawer>
            <DrawerTrigger asChild>
              <Button>Show details</Button>
            </DrawerTrigger>
            <DrawerContent aria-describedby={undefined}>
              <DrawerHeader>
                <DrawerTitle>Details</DrawerTitle>
              </DrawerHeader>
              <DrawerBody>
                <button type="button">Inside the sheet</button>
              </DrawerBody>
            </DrawerContent>
          </Drawer>
        </DialogContent>
      </Dialog>
    );

    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'Show details' }));

    const sheet = await screen.findByRole('dialog', { name: 'Details' });

    // The dialog is still mounted but no longer *the* dialog: Radix hid it from assistive
    // technology when the sheet opened, which is what "stacks correctly" means to a screen
    // reader. So it is found by its text rather than by its role.
    const dialogTitle = screen.getByText('Publish version');
    expect(dialogTitle).toBeInTheDocument();

    // The newer overlay paints last: each Radix portal appends to the end of <body>, so
    // DOM order *is* stack order at the same z-index.
    expect(
      dialogTitle.compareDocumentPosition(sheet) & Node.DOCUMENT_POSITION_FOLLOWING
    ).toBeTruthy();
    await waitFor(() => expect(sheet.contains(document.activeElement)).toBe(true));

    // Closing the top of the stack hands the dialog under it back, open and usable.
    await user.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Details' })).toBeNull());
    await waitFor(() =>
      expect(screen.getByRole('dialog', { name: 'Publish version' })).toBeInTheDocument()
    );
  });

  it.each([
    [undefined, 'max-w-[32.5rem]'],
    ['lg', 'max-w-[42.5rem]'],
    ['xl', 'max-w-[53.75rem]'],
  ] as const)('renders the %s width from the DESIGN.md §5.4 vocabulary', async (size, expected) => {
    renderDrawer(size ? { size } : {});
    await userEvent.setup().click(screen.getByRole('button', { name: 'Open drawer' }));
    const classes = classesOf(await screen.findByRole('dialog'));
    expect(classes).toContain(expected);
    // The slide-in is a CSS animation keyed off Radix's own `data-state`.
    expect(classes).toContain('hive-drawer');
  });

  it('offers the full page when one exists, as a link', async () => {
    renderDrawer();
    await userEvent.setup().click(screen.getByRole('button', { name: 'Open drawer' }));
    const link = await screen.findByRole('link', { name: 'Open full page' });
    expect(link).toHaveAttribute('href', '/ade/dashboard/audit/evt_9c1d');
  });

  it('is axe-clean while open', async () => {
    const { container, baseElement } = renderDrawer();
    await userEvent.setup().click(screen.getByRole('button', { name: 'Open drawer' }));
    await screen.findByRole('dialog');
    // The sheet is portalled, so the whole document is the subject rather than `container`.
    expect(container).toBeInTheDocument();
    expect(await axe(baseElement)).toHaveNoViolations();
  });
});

describe('Avatar — the identity mark', () => {
  it.each([
    ['Ada Lovelace', 'AL'],
    ['grace@example.com', 'GR'],
    ['payments-api', 'PA'],
    ['Margaret', 'MA'],
    ['  ', '?'],
    [undefined, '?'],
  ])('draws %s as %s', (name, expected) => {
    expect(avatarInitials(name)).toBe(expected);
  });

  it('gives one identity one tint, wherever and whenever it renders', () => {
    const first = avatarToneFor('user_ada');
    const second = avatarToneFor('user_ada');
    expect(first).toBe(second);
    expect(AVATAR_TINTS).toContain(first);
    // Pinned, not just stable: the tint of a given id must survive a release, or every
    // avatar in the app changes colour when this file is touched.
    expect(avatarToneFor('user_ada')).toBe('c');
    expect(avatarToneFor('user_grace')).toBe('e');
    expect(avatarToneFor('acme-corp')).toBe('c');
  });

  it('spreads identities across all five tints', () => {
    const seen = new Set(
      Array.from({ length: 200 }, (_, index) => avatarToneFor(`user_${index}`))
    );
    expect(seen.size).toBe(AVATAR_TINTS.length);
  });

  it('falls back to neutral when there is no identity to hash', () => {
    expect(avatarToneFor('')).toBe('neutral');
    expect(avatarToneFor(null)).toBe('neutral');
  });

  it('hashes the seed rather than the name, so a rename keeps the colour', () => {
    render(
      <>
        <Avatar data-testid="before" name="Ada Lovelace" seed="user_ada" />
        <Avatar data-testid="after" name="Ada King" seed="user_ada" />
      </>
    );
    expect(screen.getByTestId('before')).toHaveAttribute('data-tone', 'c');
    expect(screen.getByTestId('after')).toHaveAttribute('data-tone', 'c');
  });

  it('paints each tint from a role token pair, never from a new colour', () => {
    render(<Avatar data-testid="avatar" name="Ada Lovelace" seed="user_ada" />);
    const classes = classesOf(screen.getByTestId('avatar'));
    expect(classes).toContain('bg-ok-soft');
    expect(classes).toContain('text-ok-fg');
  });

  it.each([
    ['brand', 'bg-[image:var(--gradient-brand)]'],
    ['honey', 'bg-[image:var(--gradient-honey)]'],
    ['neutral', 'bg-inset'],
  ] as const)('paints the %s tone when it is named outright', (tone, expected) => {
    render(<Avatar data-testid="avatar" tone={tone} name="Acme Corp" />);
    expect(classesOf(screen.getByTestId('avatar'))).toContain(expected);
  });

  it.each([
    ['xs', 'size-5'],
    ['sm', 'size-6.5'],
    ['default', 'size-8'],
    ['lg', 'size-11'],
    ['xl', 'size-18'],
  ] as const)('renders the %s size', (size, expected) => {
    render(<Avatar data-testid="avatar" size={size} name="Ada Lovelace" />);
    expect(classesOf(screen.getByTestId('avatar'))).toContain(expected);
  });

  it('clips a workspace into the hexagon and a person into a circle', () => {
    render(
      <>
        <Avatar data-testid="person" name="Ada Lovelace" />
        <Avatar data-testid="workspace" shape="hex" tone="brand" name="Acme Corp" />
      </>
    );
    expect(classesOf(screen.getByTestId('person'))).toContain('rounded-full');
    expect(classesOf(screen.getByTestId('workspace'))).toContain('avatar-hex');
  });

  it('is decorative until it is given a name of its own', () => {
    const { rerender } = render(<Avatar data-testid="avatar" name="Ada Lovelace" />);
    expect(screen.getByTestId('avatar')).toHaveAttribute('aria-hidden', 'true');

    rerender(<Avatar data-testid="avatar" name="Ada Lovelace" title="Ada Lovelace" />);
    expect(screen.getByTestId('avatar')).not.toHaveAttribute('aria-hidden');

    rerender(<Avatar data-testid="avatar" name="Ada Lovelace" aria-label="Ada Lovelace" />);
    expect(screen.getByTestId('avatar')).not.toHaveAttribute('aria-hidden');
  });

  it('draws an image when there is one, without a second name for it', () => {
    const { container } = render(
      <Avatar data-testid="avatar" name="Ada Lovelace" src="https://example.test/ada.png" />
    );
    const image = container.querySelector('img');
    expect(image).toHaveAttribute('src', 'https://example.test/ada.png');
    expect(image).toHaveAttribute('alt', '');
    expect(screen.getByTestId('avatar')).not.toHaveTextContent('AL');
  });

  it('takes its own children for an overflow chip', () => {
    render(
      <AvatarStack data-testid="stack">
        <Avatar size="sm" name="Ada Lovelace" seed="user_ada" />
        <Avatar size="sm" tone="neutral">
          +4
        </Avatar>
      </AvatarStack>
    );
    const stack = screen.getByTestId('stack');
    expect(stack).toHaveTextContent('+4');
    // Overlap and the ring that makes it read as depth, both on the stack rather than on
    // each avatar — an avatar does not know it is in a stack.
    expect(classesOf(stack)).toContain('[&>*:not(:first-child)]:-ml-2');
    expect(classesOf(stack)).toContain('[&>*]:shadow-[0_0_0_2px_var(--bg-surface)]');
  });

  it('is axe-clean, named and decorative alike', async () => {
    const { container } = render(
      <div>
        <Avatar name="Ada Lovelace" seed="user_ada" />
        <Avatar shape="hex" tone="brand" name="Acme Corp" title="Acme Corp" />
        <AvatarStack>
          <Avatar size="sm" name="Grace Hopper" seed="user_grace" />
          <Avatar size="sm" src="https://example.test/ada.png" name="Ada Lovelace" />
        </AvatarStack>
      </div>
    );
    expect(await axe(container)).toHaveNoViolations();
  });
});

describe('Kbd — the shortcut chip', () => {
  it('draws one chip per key inside a hidden group', () => {
    const { container } = render(<Kbd keys={['⌘', 'K']} />);
    const group = container.querySelector('.kbd-group');
    expect(group).toHaveAttribute('aria-hidden', 'true');
    expect(group?.querySelectorAll('.kbd')).toHaveLength(2);
    expect(group).toHaveTextContent('⌘K');
  });

  it('takes a single legend as a child', () => {
    const { container } = render(<Kbd>N</Kbd>);
    expect(container.querySelectorAll('.kbd')).toHaveLength(1);
    expect(container.querySelector('.kbd')).toHaveTextContent('N');
  });

  it('renders nothing at all when there is no shortcut', () => {
    const { container } = render(<Kbd />);
    expect(container).toBeEmptyDOMElement();
  });

  it('keeps a caller class beside its own', () => {
    const { container } = render(<Kbd className="ml-1">N</Kbd>);
    expect(classesOf(container.firstElementChild as Element)).toEqual(
      new Set(['kbd-group', 'ml-1'])
    );
  });

  it('leaves an accessible spelling to whoever needs one', () => {
    // The chips are hidden, so a surface that has to *say* the chord writes it beside
    // them — outside what `html[data-kbd-hints="off"]` hides.
    render(
      <span>
        <Kbd keys={['⌘', ',']} />
        <span className="sr-only">Command comma</span>
      </span>
    );
    expect(screen.getByText('Command comma')).toBeInTheDocument();
  });

  it('is axe-clean', async () => {
    const { container } = render(<Kbd keys={['⌘', 'K']} />);
    expect(await axe(container)).toHaveNoViolations();
  });
});

describe('the primitives compose', () => {
  it('puts an avatar and a shortcut inside a drawer without either losing its contract', async () => {
    render(
      <Drawer defaultOpen>
        {/* No `DrawerDescription`, so the sheet says so — see `DrawerContent`. */}
        <DrawerContent aria-describedby={undefined}>
          <DrawerHeader>
            <DrawerTitle>Grace Hopper</DrawerTitle>
          </DrawerHeader>
          <DrawerBody>
            <Avatar data-testid="avatar" size="lg" name="Grace Hopper" seed="user_grace" />
            <Button kbd="E">Edit roles</Button>
          </DrawerBody>
        </DrawerContent>
      </Drawer>
    );

    const sheet = await screen.findByRole('dialog', { name: 'Grace Hopper' });
    expect(within(sheet).getByTestId('avatar')).toHaveAttribute('data-tone', 'e');
    expect(sheet.querySelector('.kbd')).toHaveTextContent('E');
  });

  it('survives being unmounted while open', () => {
    // Epics 3 and 5 open a drawer from a row and then navigate; an unmount mid-animation
    // must not throw, or a route change leaves the app with a dead overlay.
    const { unmount } = render(
      <Drawer defaultOpen>
        <DrawerContent aria-describedby={undefined}>
          <DrawerHeader>
            <DrawerTitle>Detail</DrawerTitle>
          </DrawerHeader>
        </DrawerContent>
      </Drawer>
    );
    expect(() => act(() => unmount())).not.toThrow();
  });

  it('fires no act warning when a segmented option is clicked', () => {
    const consoleError = jest.spyOn(console, 'error').mockImplementation(() => {});
    render(
      <Segmented aria-label="View" defaultValue="cards">
        <SegmentedItem value="cards">Cards</SegmentedItem>
        <SegmentedItem value="table">Table</SegmentedItem>
      </Segmented>
    );
    fireEvent.click(screen.getByRole('radio', { name: 'Table' }));
    expect(screen.getByRole('radio', { name: 'Table' })).toBeChecked();
    expect(consoleError).not.toHaveBeenCalled();
    consoleError.mockRestore();
  });
});
