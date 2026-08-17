/**
 * The shortcuts sheet and the host that binds it (HIVE-3.7, #5293).
 *
 * The acceptance criteria of the ticket, in order:
 *
 *   1. **`?` opens the sheet from anywhere except a text field.**
 *   2. **No binding fires while focus is in an input, textarea or contenteditable.**
 *   3. **Sheet content is generated, not hand-written** — which is asserted the only way it
 *      can be: by changing what is *registered* and watching the sheet change with it. A
 *      table on screen puts its row keys in the sheet; unmounting it takes them out again.
 *   4. **Sequence shortcuts time out after a second** — the engine's half is in
 *      `tests/shortcut-registry.test.tsx`; here it is `G` `P` actually reaching the route.
 *
 * Plus the two things a generated reference has to get right to be worth having: a gated
 * shortcut keeps its row *and* states why, and a row that can run is reachable by a reader
 * who cannot press the chord.
 */

import React from 'react';
import { act, fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import '@testing-library/jest-dom';
import { axe } from 'jest-axe';
import 'jest-axe/extend-expect';

const mockPush = jest.fn<void, [string]>();

jest.mock('next/navigation', () => ({
  useRouter: () => ({ push: mockPush, replace: jest.fn(), refresh: jest.fn() }),
  usePathname: () => '/ade/dashboard',
  useSearchParams: () => new URLSearchParams(),
}));

import ShortcutsHost from '../src/app/components/shell/ShortcutsHost';
import { openShortcutSheet } from '../src/app/components/shell/shortcutSheetBus';
import { DataTable, type DataTableColumn } from '../src/app/components/ui';
import { resetShortcutSequence } from '../src/app/hooks/useShortcuts';

/** The workspace a signed-in reader has selected. */
const TENANT_ID = 'ten_01HJ7';

/** A fixture list, so the "On a list" section has an owner. */
interface Project {
  id: string;
  name: string;
}

const PROJECT_COLUMNS: DataTableColumn<Project>[] = [
  { id: 'name', header: 'Name', cell: (project) => project.name },
];

const PROJECTS: Project[] = [{ id: 'p1', name: 'Payments API' }];

afterEach(() => {
  resetShortcutSequence();
  mockPush.mockClear();
});

/** Press a bare `?`, the way a reader looking for help does. */
function pressQuestionMark(target: Element | Document = document.body) {
  fireEvent.keyDown(target, { key: '?', shiftKey: true });
}

/** The open sheet. */
function sheet() {
  return screen.getByTestId('shortcut-sheet');
}

/** One row of the sheet, by the id of the binding that produced it. */
function row(id: string): HTMLElement {
  const found = sheet().querySelector<HTMLElement>(`[data-shortcut="${id}"]`);
  if (!found) throw new Error(`the sheet has no row for “${id}”`);
  return found;
}

describe('opening the sheet', () => {
  it('opens on ? from anywhere on the page', async () => {
    render(<ShortcutsHost currentTenantId={TENANT_ID} />);

    pressQuestionMark();

    expect(await screen.findByTestId('shortcut-sheet')).toBeInTheDocument();
    expect(screen.getByRole('dialog')).toHaveAccessibleName('Keyboard shortcuts');
  });

  it('leaves ? alone while the reader is typing one', () => {
    render(<ShortcutsHost currentTenantId={TENANT_ID} />);

    const field = document.createElement('input');
    document.body.appendChild(field);
    field.focus();

    pressQuestionMark(field);
    expect(screen.queryByTestId('shortcut-sheet')).not.toBeInTheDocument();

    field.remove();
  });

  it('leaves ⌘? and Ctrl+? to the browser, which already binds them', () => {
    render(<ShortcutsHost currentTenantId={TENANT_ID} />);

    fireEvent.keyDown(document.body, { key: '?', metaKey: true });
    fireEvent.keyDown(document.body, { key: '?', ctrlKey: true });

    expect(screen.queryByTestId('shortcut-sheet')).not.toBeInTheDocument();
  });

  it('answers the bus, for the rail menu row and the preferences pane', async () => {
    render(<ShortcutsHost currentTenantId={TENANT_ID} />);

    act(() => {
      expect(openShortcutSheet()).toBe(true);
    });

    expect(await screen.findByTestId('shortcut-sheet')).toBeInTheDocument();
  });

  it('reports no host rather than throwing when nothing is mounted', () => {
    expect(openShortcutSheet()).toBe(false);
  });

  it('closes on Done, on Esc and on the close button', async () => {
    const user = userEvent.setup();
    render(<ShortcutsHost currentTenantId={TENANT_ID} />);

    for (const leave of [
      async () => user.click(screen.getByRole('button', { name: 'Done' })),
      async () => user.keyboard('{Escape}'),
      async () => user.click(screen.getByRole('button', { name: 'Close' })),
    ]) {
      act(() => {
        pressQuestionMark();
      });
      await screen.findByTestId('shortcut-sheet');

      await leave();
      expect(screen.queryByTestId('shortcut-sheet')).not.toBeInTheDocument();
    }
  });

  it('gives focus back to whatever opened it', async () => {
    const user = userEvent.setup();
    render(
      <>
        <button type="button">Keyboard shortcuts</button>
        <ShortcutsHost currentTenantId={TENANT_ID} />
      </>
    );

    const trigger = screen.getByRole('button', { name: 'Keyboard shortcuts' });
    trigger.focus();

    act(() => {
      pressQuestionMark(trigger);
    });
    await screen.findByTestId('shortcut-sheet');

    await user.click(screen.getByRole('button', { name: 'Done' }));
    expect(trigger).toHaveFocus();
  });
});

describe('what the sheet says', () => {
  it('prints the shortcuts this host registers, under their scope headings', async () => {
    render(<ShortcutsHost currentTenantId={TENANT_ID} />);
    act(() => pressQuestionMark());
    await screen.findByTestId('shortcut-sheet');

    expect(sheet()).toHaveTextContent('Global');
    expect(row('shortcuts')).toHaveTextContent('Show the keyboard shortcuts');
    expect(row('close-overlay')).toHaveTextContent('Close the pane, dialog or menu in front');

    expect(sheet()).toHaveTextContent('Jump (press G, then…)');
    // The label is the navigation model's own, so the sheet and the rail read the same.
    expect(row('jump-lint')).toHaveTextContent('Lint posture');
  });

  it('draws each chord as chips and spells it beside them for a screen reader', async () => {
    render(<ShortcutsHost currentTenantId={TENANT_ID} />);
    act(() => pressQuestionMark());
    await screen.findByTestId('shortcut-sheet');

    const projects = row('jump-projects');
    expect(within(projects).getByText('G')).toBeInTheDocument();
    expect(within(projects).getByText('P')).toBeInTheDocument();
    // The chips are `aria-hidden`, so the chord is written out where the keyboard-hints
    // preference cannot hide it.
    expect(projects).toHaveTextContent('G then P');
  });

  it('has no section for shortcuts nothing is registering', async () => {
    render(<ShortcutsHost currentTenantId={TENANT_ID} />);
    act(() => pressQuestionMark());
    await screen.findByTestId('shortcut-sheet');

    // No palette host here, so no `⌘K` row; no dialog registering `⌘↵`, so no dialog section.
    expect(sheet().querySelector('[data-shortcut="palette"]')).toBeNull();
    expect(sheet()).not.toHaveTextContent('Dialogs and wizards');
  });

  it('grows the list rows a table owns, and loses them when the table goes', async () => {
    const table = (
      <DataTable
        caption="Projects"
        columns={PROJECT_COLUMNS}
        rows={PROJECTS}
        getRowId={(project: Project) => project.id}
        getRowLabel={(project: Project) => project.name}
      />
    );

    const view = render(
      <>
        {table}
        <ShortcutsHost currentTenantId={TENANT_ID} />
      </>
    );
    act(() => pressQuestionMark());
    await screen.findByTestId('shortcut-sheet');

    expect(sheet()).toHaveTextContent('On a list');
    expect(row('list-move')).toHaveTextContent('Move between rows');
    // Selection is not on for this table, so the key that selects a row is not promised.
    expect(sheet().querySelector('[data-shortcut="list-select"]')).toBeNull();

    await userEvent.setup().click(screen.getByRole('button', { name: 'Done' }));
    view.rerender(<ShortcutsHost currentTenantId={TENANT_ID} />);

    act(() => pressQuestionMark());
    await screen.findByTestId('shortcut-sheet');
    expect(sheet().querySelector('[data-shortcut="list-move"]')).toBeNull();
    // The section itself stays: `N` and `I` are the shell's, and they still work here.
    expect(row('list-new')).toHaveTextContent('New project…');
  });
});

describe('jumping', () => {
  it('goes where the navigation model says, on G then the letter', async () => {
    render(<ShortcutsHost currentTenantId={TENANT_ID} />);

    fireEvent.keyDown(document.body, { key: 'g' });
    fireEvent.keyDown(document.body, { key: 'p' });

    expect(mockPush).toHaveBeenCalledWith('/ade/dashboard/projects');
  });

  it('binds the palette’s own N and I to the palette’s own rows', async () => {
    render(<ShortcutsHost currentTenantId={TENANT_ID} />);

    fireEvent.keyDown(document.body, { key: 'n' });
    expect(mockPush).toHaveBeenCalledWith(expect.stringContaining('open=new-project'));

    fireEvent.keyDown(document.body, { key: 'i' });
    expect(mockPush).toHaveBeenCalledWith(expect.stringContaining('open=import-spec'));
  });

  it('keeps a gated jump on screen, says why, and does not take the reader there', async () => {
    render(<ShortcutsHost currentTenantId={null} />);

    fireEvent.keyDown(document.body, { key: 'g' });
    fireEvent.keyDown(document.body, { key: 'p' });
    expect(mockPush).not.toHaveBeenCalled();

    act(() => pressQuestionMark());
    await screen.findByTestId('shortcut-sheet');

    expect(row('jump-projects')).toHaveTextContent('Select a workspace to use Projects.');
    // A reason is no use to a reader who cannot find the row it belongs to.
    expect(row('jump-projects')).toHaveTextContent('Projects');
    expect(screen.queryByTestId('shortcut-run-jump-projects')).not.toBeInTheDocument();
  });
});

describe('running a shortcut from the sheet', () => {
  it('lets a reader who cannot press the chord click the row instead', async () => {
    const user = userEvent.setup();
    render(<ShortcutsHost currentTenantId={TENANT_ID} />);

    act(() => pressQuestionMark());
    await screen.findByTestId('shortcut-sheet');

    await user.click(screen.getByTestId('shortcut-run-jump-catalog'));

    expect(mockPush).toHaveBeenCalledWith('/ade/dashboard/catalog');
    // …and the sheet is out of the way before the route changes.
    expect(screen.queryByTestId('shortcut-sheet')).not.toBeInTheDocument();
  });

  it('leaves a documentation row and the sheet’s own chord as plain text', async () => {
    render(<ShortcutsHost currentTenantId={TENANT_ID} />);
    act(() => pressQuestionMark());
    await screen.findByTestId('shortcut-sheet');

    // `Esc` is Radix's; running `?` from inside the sheet would only close and reopen it.
    expect(screen.queryByTestId('shortcut-run-close-overlay')).not.toBeInTheDocument();
    expect(screen.queryByTestId('shortcut-run-shortcuts')).not.toBeInTheDocument();
  });
});

describe('accessibility', () => {
  it('has no axe violations, open', async () => {
    render(<ShortcutsHost currentTenantId={TENANT_ID} />);
    act(() => pressQuestionMark());
    await screen.findByTestId('shortcut-sheet');

    expect(await axe(document.body)).toHaveNoViolations();
  });

  it('has no axe violations with every workspace-scoped row gated', async () => {
    render(<ShortcutsHost currentTenantId={null} />);
    act(() => pressQuestionMark());
    await screen.findByTestId('shortcut-sheet');

    expect(await axe(document.body)).toHaveNoViolations();
  });
});
