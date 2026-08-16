/**
 * The DataTable primitive (HIVE-2.3, #5282).
 *
 * `DataTable` replaces forty hand-rolled tables, so the contract it has to hold is the union
 * of what those forty pages each did slightly differently. This suite is organised around the
 * ticket's acceptance criteria rather than around the component's methods:
 *
 *   1. **It renders the mockups' three reference tables** — Projects, API keys and Catalog —
 *      from column definitions alone, with no page-local table CSS. Those three between them
 *      use every feature the primitive has, which is why they are the fixtures.
 *   2. **Keyboard**: arrow-key row movement, `X` select, `↵` open, `.` row actions — and,
 *      just as importantly, keys the table must *not* steal from a control inside a cell.
 *   3. **Selecting rows reveals the bulk bar; clearing selection hides it.**
 *   4. **Sort is announced, not just drawn** — `aria-sort` on the `<th>`, a real button
 *      inside it, and the asc → desc → unsorted cycle.
 *   5. **The three no-rows states** — loading, empty and error — which are the ones pages
 *      most often left out.
 *
 * Plus a standing axe sweep over each of the three fixtures, because a table is where a
 * missing header scope or an unlabelled checkbox does the most damage.
 *
 * The URL codec's half is `tests/hive-data-table-url-state.test.ts`.
 */

import React from 'react';
import { act, fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import '@testing-library/jest-dom';
import { axe } from 'jest-axe';
import 'jest-axe/extend-expect';

import {
  Badge,
  Button,
  DataTable,
  DataTableBulkAction,
  DataTableCellPrimary,
  DataTableCellSub,
  DataTableFilterChip,
  DataTableFoot,
  DataTablePager,
  DataTableSearch,
  DataTableToolbar,
  DataTableToolbarSpacer,
  dataTablePageWindow,
  dataTableRangeLabel,
  type DataTableColumn,
  type DataTableSortState,
} from '../src/app/components/ui';

// ---------------------------------------------------------------------------------------
// Fixtures — the three reference tables from the mockups
// ---------------------------------------------------------------------------------------

/** `docs/mockups/build/projects.html` — the list with an avatar, a sub-line and row actions. */
interface Project {
  id: string;
  name: string;
  slug: string;
  versions: number;
  status: string;
  updated: string;
}

const PROJECTS: Project[] = [
  { id: 'p1', name: 'Payments API', slug: 'payments-api', versions: 12, status: 'Active', updated: 'Aug 15' },
  { id: 'p2', name: 'Orders Service', slug: 'orders-service', versions: 4, status: 'Active', updated: 'Aug 12' },
  { id: 'p3', name: 'Inventory Events', slug: 'inventory-events', versions: 7, status: 'Draft', updated: 'Jul 30' },
  { id: 'p4', name: 'Legacy Gateway', slug: 'legacy-gateway', versions: 1, status: 'Deleted', updated: 'Jun 3' },
];

const PROJECT_COLUMNS: Array<DataTableColumn<Project>> = [
  {
    id: 'name',
    header: 'Project',
    sortable: true,
    skeletonWidth: '9rem',
    cell: (project) => (
      <>
        <DataTableCellPrimary>{project.name}</DataTableCellPrimary>
        <DataTableCellSub className="mono">{project.slug}</DataTableCellSub>
      </>
    ),
  },
  {
    id: 'versions',
    header: 'Versions',
    sortable: true,
    align: 'end',
    cell: (project) => project.versions,
  },
  {
    id: 'status',
    header: 'Status',
    sortable: true,
    cell: (project) => <Badge>{project.status}</Badge>,
  },
  { id: 'updated', header: 'Updated', sortable: true, cell: (project) => project.updated },
  {
    id: 'actions',
    headerLabel: 'Actions',
    actions: true,
    align: 'end',
    cell: (project) => (
      <>
        <Button variant="ghost" size="sm" aria-label={`Edit ${project.name}`}>
          Edit
        </Button>
        <Button variant="ghost" size="sm" aria-label={`More actions for ${project.name}`}>
          …
        </Button>
      </>
    ),
  },
];

/** `docs/mockups/workspace/api-keys.html` — the list whose rows are not all selectable. */
interface ApiKey {
  id: string;
  name: string;
  prefix: string;
  status: 'Active' | 'Revoked';
}

const API_KEYS: ApiKey[] = [
  { id: 'k1', name: 'ci-deploy', prefix: 'apk_live_7f3a…', status: 'Active' },
  { id: 'k2', name: 'lint-bot', prefix: 'apk_live_a91c…', status: 'Active' },
  { id: 'k3', name: 'old-agent', prefix: 'apk_live_0c22…', status: 'Revoked' },
];

const API_KEY_COLUMNS: Array<DataTableColumn<ApiKey>> = [
  { id: 'name', header: 'Name', sortable: true, cell: (key) => key.name },
  { id: 'prefix', header: 'Prefix', className: 'mono', cell: (key) => key.prefix },
  { id: 'status', header: 'Status', cell: (key) => <Badge>{key.status}</Badge> },
];

/** `docs/mockups/sources/catalog.html` — the wide list that scrolls inside its own card. */
interface CatalogItem {
  id: string;
  title: string;
  format: string;
  version: string;
  owner: string;
  imported: string;
}

const CATALOG: CatalogItem[] = [
  { id: 'c1', title: 'Stripe API', format: 'OpenAPI 3.1', version: '2024-06', owner: 'Ada', imported: 'Aug 1' },
  { id: 'c2', title: 'Twilio Messaging', format: 'OpenAPI 3.0', version: 'v1', owner: 'Grace', imported: 'Jul 9' },
];

const CATALOG_COLUMNS: Array<DataTableColumn<CatalogItem>> = [
  { id: 'title', header: 'Item', sortable: true, cell: (item) => item.title },
  { id: 'format', header: 'Format', cell: (item) => item.format },
  { id: 'version', header: 'Version', cell: (item) => item.version },
  { id: 'owner', header: 'Owner', cell: (item) => item.owner },
  { id: 'imported', header: 'Imported', sortable: true, align: 'end', cell: (item) => item.imported },
];

// ---------------------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------------------

/**
 * A Projects table with selection and sort wired to real state, as a page would wire them.
 *
 * @param props Overrides for the table, plus spies for what the page would be told.
 * @returns The rendered harness.
 */
function ProjectsTable({
  onActivate,
  onSelection,
  ...overrides
}: Partial<React.ComponentProps<typeof DataTable<Project>>> & {
  onActivate?: (project: Project) => void;
  onSelection?: (ids: string[]) => void;
} = {}) {
  function Harness() {
    const [selected, setSelected] = React.useState<string[]>([]);
    const [sort, setSort] = React.useState<DataTableSortState | null>({
      column: 'name',
      direction: 'asc',
    });

    return (
      <DataTable
        caption="Projects"
        columns={PROJECT_COLUMNS}
        rows={PROJECTS}
        getRowId={(project) => project.id}
        getRowLabel={(project) => project.name}
        selectedIds={selected}
        onSelectionChange={(ids) => {
          setSelected(ids);
          onSelection?.(ids);
        }}
        sort={sort}
        onSortChange={setSort}
        onRowActivate={onActivate}
        bulkActions={<DataTableBulkAction>Archive</DataTableBulkAction>}
        {...overrides}
      />
    );
  }

  return render(<Harness />);
}

/** The `<tr>` elements of the table body, in order. */
function bodyRows(): HTMLElement[] {
  const [, body] = screen.getAllByRole('rowgroup');
  return within(body).getAllByRole('row');
}

/**
 * Move focus, and let React flush what that focus changes.
 *
 * Landing on a row moves the table's roving `tabindex`, which is a state update — outside
 * `act` React (rightly) warns that the assertion is racing the re-render.
 *
 * @param element The element to focus.
 * @returns The same element, so it can be asserted on inline.
 */
function focusElement<Element extends HTMLElement>(element: Element): Element {
  act(() => element.focus());
  return element;
}

// ---------------------------------------------------------------------------------------

describe('the three reference tables render from column definitions alone', () => {
  it('draws the Projects table: caption, headers, a row per project', () => {
    ProjectsTable();

    expect(screen.getByRole('table', { name: 'Projects' })).toBeInTheDocument();
    for (const header of ['Project', 'Versions', 'Status', 'Updated']) {
      expect(screen.getByRole('columnheader', { name: new RegExp(header) })).toBeInTheDocument();
    }
    // The actions column is named for assistive technology even though it draws no label.
    expect(screen.getByRole('columnheader', { name: 'Actions' })).toBeInTheDocument();
    expect(bodyRows()).toHaveLength(PROJECTS.length);
    expect(screen.getByText('payments-api')).toBeInTheDocument();
  });

  it('draws the API keys table, whose revoked row cannot be selected', () => {
    render(
      <DataTable
        caption="API keys"
        columns={API_KEY_COLUMNS}
        rows={API_KEYS}
        getRowId={(key) => key.id}
        getRowLabel={(key) => key.name}
        selectedIds={[]}
        onSelectionChange={jest.fn()}
        isRowSelectable={(key) => key.status === 'Active'}
      />
    );

    expect(screen.getByRole('checkbox', { name: 'Select ci-deploy' })).toBeEnabled();
    expect(screen.getByRole('checkbox', { name: 'Select old-agent' })).toBeDisabled();
  });

  it('draws the Catalog table wide, scrolling inside its own card rather than the page', () => {
    const { container } = render(
      <DataTable
        caption="Catalog"
        columns={CATALOG_COLUMNS}
        rows={CATALOG}
        getRowId={(item) => item.id}
        scrollX
      />
    );

    // The scroll container is the table's own wrapper — never the document (DESIGN.md §5:
    // no horizontal document scroll at ≥1280 px).
    const scroller = container.querySelector('.overflow-x-auto');
    expect(scroller).toBeInTheDocument();
    expect(scroller).toContainElement(screen.getByRole('table', { name: 'Catalog' }));
    // Keyboard users must be able to reach a scroll container that only a pointer could
    // otherwise pan (WCAG 2.1.1).
    expect(scroller).toHaveAttribute('tabindex', '0');
  });

  it.each([
    ['Projects', <DataTable key="p" caption="Projects" columns={PROJECT_COLUMNS} rows={PROJECTS} getRowId={(p: Project) => p.id} getRowLabel={(p: Project) => p.name} selectedIds={['p1']} onSelectionChange={jest.fn()} sort={{ column: 'name', direction: 'asc' }} onSortChange={jest.fn()} bulkActions={<DataTableBulkAction>Archive</DataTableBulkAction>} footer={<DataTableFoot><span>4 projects</span><DataTablePager page={1} pageCount={3} onPageChange={jest.fn()} /></DataTableFoot>} />],
    ['API keys', <DataTable key="k" caption="API keys" columns={API_KEY_COLUMNS} rows={API_KEYS} getRowId={(k: ApiKey) => k.id} getRowLabel={(k: ApiKey) => k.name} selectedIds={[]} onSelectionChange={jest.fn()} toolbar={<DataTableToolbar><DataTableSearch aria-label="Filter API keys" /><DataTableFilterChip active count={2}>Active</DataTableFilterChip><DataTableToolbarSpacer /></DataTableToolbar>} />],
    ['Catalog', <DataTable key="c" caption="Catalog" columns={CATALOG_COLUMNS} rows={CATALOG} getRowId={(c: CatalogItem) => c.id} scrollX />],
  ])('%s has no axe violations', async (_name, element) => {
    const { container } = render(element);
    expect(await axe(container)).toHaveNoViolations();
  });
});

describe('sorting', () => {
  it('announces the sorted column with aria-sort, and the rest as sortable', () => {
    ProjectsTable();

    expect(screen.getByRole('columnheader', { name: /Project/ })).toHaveAttribute(
      'aria-sort',
      'ascending'
    );
    expect(screen.getByRole('columnheader', { name: /Versions/ })).toHaveAttribute(
      'aria-sort',
      'none'
    );
    // A column that cannot be sorted says nothing at all, rather than saying "none".
    expect(screen.getByRole('columnheader', { name: 'Actions' })).not.toHaveAttribute('aria-sort');
  });

  it('cycles a column ascending → descending → the screen’s own order', async () => {
    const user = userEvent.setup();
    ProjectsTable();

    const header = () => screen.getByRole('columnheader', { name: /Project/ });
    const button = () => within(header()).getByRole('button');

    await user.click(button());
    expect(header()).toHaveAttribute('aria-sort', 'descending');

    await user.click(button());
    expect(header()).toHaveAttribute('aria-sort', 'none');

    await user.click(button());
    expect(header()).toHaveAttribute('aria-sort', 'ascending');
  });

  it('starts a different column ascending, and lets the old one go', async () => {
    const user = userEvent.setup();
    ProjectsTable();

    await user.click(
      within(screen.getByRole('columnheader', { name: /Versions/ })).getByRole('button')
    );

    expect(screen.getByRole('columnheader', { name: /Versions/ })).toHaveAttribute(
      'aria-sort',
      'ascending'
    );
    expect(screen.getByRole('columnheader', { name: /Project/ })).toHaveAttribute(
      'aria-sort',
      'none'
    );
  });

  it('offers the sort affordance as a real button, reachable by keyboard', async () => {
    const user = userEvent.setup();
    ProjectsTable();

    const button = within(screen.getByRole('columnheader', { name: /Project/ })).getByRole(
      'button'
    );
    focusElement(button);
    await user.keyboard('{Enter}');

    expect(screen.getByRole('columnheader', { name: /Project/ })).toHaveAttribute(
      'aria-sort',
      'descending'
    );
  });

  it('draws no sort affordance when the caller has no handler for it', () => {
    render(
      <DataTable caption="Catalog" columns={CATALOG_COLUMNS} rows={CATALOG} getRowId={(c) => c.id} />
    );
    expect(
      within(screen.getByRole('columnheader', { name: 'Item' })).queryByRole('button')
    ).not.toBeInTheDocument();
  });
});

describe('selection and the bulk bar', () => {
  it('is hidden until something is selected, and hides again when the selection clears', async () => {
    const user = userEvent.setup();
    ProjectsTable();

    expect(screen.queryByRole('group', { name: 'Bulk actions' })).not.toBeInTheDocument();

    await user.click(screen.getByRole('checkbox', { name: 'Select Payments API' }));
    const bar = screen.getByRole('group', { name: 'Bulk actions' });
    expect(within(bar).getByText('1 row selected')).toBeInTheDocument();

    await user.click(within(bar).getByRole('button', { name: 'Clear selection' }));
    expect(screen.queryByRole('group', { name: 'Bulk actions' })).not.toBeInTheDocument();
  });

  it('counts in the plural, and carries the caller’s own verbs', async () => {
    const user = userEvent.setup();
    ProjectsTable();

    await user.click(screen.getByRole('checkbox', { name: 'Select Payments API' }));
    await user.click(screen.getByRole('checkbox', { name: 'Select Orders Service' }));

    const bar = screen.getByRole('group', { name: 'Bulk actions' });
    expect(within(bar).getByText('2 rows selected')).toBeInTheDocument();
    expect(within(bar).getByRole('button', { name: 'Archive' })).toBeInTheDocument();
  });

  it('announces the count in a live region, so it is not a visual-only change', async () => {
    const user = userEvent.setup();
    ProjectsTable();

    const status = screen.getByRole('status');
    expect(status).toHaveTextContent('');

    await user.click(screen.getByRole('checkbox', { name: 'Select Payments API' }));
    expect(status).toHaveTextContent('1 selected');
  });

  it('select-all takes every row, and is indeterminate while only some are taken', async () => {
    const user = userEvent.setup();
    const onSelection = jest.fn();
    ProjectsTable({ onSelection });

    await user.click(screen.getByRole('checkbox', { name: 'Select Payments API' }));
    expect(screen.getByRole('checkbox', { name: 'Select all rows' })).toHaveAttribute(
      'data-state',
      'indeterminate'
    );

    await user.click(screen.getByRole('checkbox', { name: 'Select all rows' }));
    expect(onSelection).toHaveBeenLastCalledWith(PROJECTS.map((project) => project.id));

    await user.click(screen.getByRole('checkbox', { name: 'Clear selection' }));
    expect(onSelection).toHaveBeenLastCalledWith([]);
  });

  it('select-all skips rows the caller held back, and leaves other pages’ ids alone', async () => {
    const user = userEvent.setup();
    const onSelectionChange = jest.fn();

    render(
      <DataTable
        caption="API keys"
        columns={API_KEY_COLUMNS}
        rows={API_KEYS}
        getRowId={(key) => key.id}
        getRowLabel={(key) => key.name}
        selectedIds={['from-another-page']}
        onSelectionChange={onSelectionChange}
        isRowSelectable={(key) => key.status === 'Active'}
      />
    );

    await user.click(screen.getByRole('checkbox', { name: 'Select all rows' }));
    expect(onSelectionChange).toHaveBeenCalledWith(['from-another-page', 'k1', 'k2']);
  });

  it('does not open a row when its checkbox is what was clicked', async () => {
    const user = userEvent.setup();
    const onActivate = jest.fn();
    ProjectsTable({ onActivate });

    await user.click(screen.getByRole('checkbox', { name: 'Select Payments API' }));
    expect(onActivate).not.toHaveBeenCalled();
  });

  it('adds no checkbox column at all when the table has no selection model', () => {
    render(
      <DataTable caption="Catalog" columns={CATALOG_COLUMNS} rows={CATALOG} getRowId={(c) => c.id} />
    );
    expect(screen.queryByRole('checkbox')).not.toBeInTheDocument();
  });
});

describe('the keyboard (DESIGN.md §8)', () => {
  it('is one Tab stop for the whole table, not one per row', () => {
    ProjectsTable();
    const rows = bodyRows();

    expect(rows[0]).toHaveAttribute('tabindex', '0');
    for (const row of rows.slice(1)) expect(row).toHaveAttribute('tabindex', '-1');
  });

  it('moves between rows with the arrow keys, and to the ends with Home and End', async () => {
    const user = userEvent.setup();
    ProjectsTable();
    const rows = bodyRows();

    focusElement(rows[0]);
    await user.keyboard('{ArrowDown}');
    expect(rows[1]).toHaveFocus();

    await user.keyboard('{ArrowDown}{ArrowUp}');
    expect(rows[1]).toHaveFocus();

    await user.keyboard('{End}');
    expect(rows[rows.length - 1]).toHaveFocus();

    await user.keyboard('{Home}');
    expect(rows[0]).toHaveFocus();
  });

  it('stops at the ends rather than wrapping — a list has a top and a bottom', async () => {
    const user = userEvent.setup();
    ProjectsTable();
    const rows = bodyRows();

    focusElement(rows[0]);
    await user.keyboard('{ArrowUp}');
    expect(rows[0]).toHaveFocus();
  });

  it('moves the Tab stop to the row the keyboard last visited', async () => {
    const user = userEvent.setup();
    ProjectsTable();
    const rows = bodyRows();

    focusElement(rows[0]);
    await user.keyboard('{ArrowDown}');
    expect(bodyRows()[1]).toHaveAttribute('tabindex', '0');
    expect(bodyRows()[0]).toHaveAttribute('tabindex', '-1');
  });

  it('selects the focused row with X', async () => {
    const user = userEvent.setup();
    ProjectsTable();

    focusElement(bodyRows()[1]);
    await user.keyboard('x');
    expect(screen.getByRole('checkbox', { name: 'Select Orders Service' })).toBeChecked();

    await user.keyboard('X');
    expect(screen.getByRole('checkbox', { name: 'Select Orders Service' })).not.toBeChecked();
  });

  it('refuses X on a row the caller held back', async () => {
    const user = userEvent.setup();
    const onSelectionChange = jest.fn();

    render(
      <DataTable
        caption="API keys"
        columns={API_KEY_COLUMNS}
        rows={API_KEYS}
        getRowId={(key) => key.id}
        getRowLabel={(key) => key.name}
        selectedIds={[]}
        onSelectionChange={onSelectionChange}
        isRowSelectable={(key) => key.status === 'Active'}
      />
    );

    focusElement(bodyRows()[2]);
    await user.keyboard('x');
    expect(onSelectionChange).not.toHaveBeenCalled();
  });

  it('opens the focused row with Enter, and with a click', async () => {
    const user = userEvent.setup();
    const onActivate = jest.fn();
    ProjectsTable({ onActivate });

    focusElement(bodyRows()[2]);
    await user.keyboard('{Enter}');
    expect(onActivate).toHaveBeenCalledWith(PROJECTS[2]);

    await user.click(screen.getByText('payments-api'));
    expect(onActivate).toHaveBeenLastCalledWith(PROJECTS[0]);
  });

  it('reaches the row’s actions with the full stop', async () => {
    const user = userEvent.setup();
    ProjectsTable();

    focusElement(bodyRows()[0]);
    await user.keyboard('.');
    expect(screen.getByRole('button', { name: 'Edit Payments API' })).toHaveFocus();
  });

  it('leaves the keys alone when focus is on a control inside a cell', () => {
    const onActivate = jest.fn();
    ProjectsTable({ onActivate });

    // A menu button, an inline select or a link owns its own arrow keys; a table that
    // hijacked them from inside a cell would break every one of them.
    const edit = screen.getByRole('button', { name: 'Edit Orders Service' });
    focusElement(edit);
    fireEvent.keyDown(edit, { key: 'ArrowDown' });
    expect(edit).toHaveFocus();

    fireEvent.keyDown(edit, { key: 'x' });
    expect(screen.getByRole('checkbox', { name: 'Select Orders Service' })).not.toBeChecked();
    expect(onActivate).not.toHaveBeenCalled();
  });

  it('leaves a browser shortcut alone — ⌘X is cut, not select', () => {
    ProjectsTable();

    const row = bodyRows()[0];
    focusElement(row);
    fireEvent.keyDown(row, { key: 'x', metaKey: true });
    expect(screen.getByRole('checkbox', { name: 'Select Payments API' })).not.toBeChecked();
  });
});

describe('the states a list is in when it has no rows', () => {
  it('draws skeleton rows shaped like the content, hidden from assistive technology', () => {
    const { container } = render(
      <DataTable
        caption="Projects"
        columns={PROJECT_COLUMNS}
        rows={[]}
        getRowId={(project: Project) => project.id}
        loading
        skeletonRows={3}
      />
    );

    // Queried from the DOM rather than by role: the placeholder rows are `aria-hidden`, so
    // they are — correctly — not in the accessibility tree at all.
    const rows = container.querySelectorAll('tbody tr');
    expect(rows).toHaveLength(3);
    for (const row of rows) expect(row).toHaveAttribute('aria-hidden', 'true');

    // Shaped per column, not one uniform bar: the name column is the widest, and the
    // actions column gets no bar at all because nothing loads into it.
    const bars = container.querySelectorAll<HTMLElement>('tbody tr:first-child .hive-skeleton');
    expect(bars).toHaveLength(PROJECT_COLUMNS.length - 1);
    expect(bars[0]).toHaveStyle({ width: '9rem' });
    expect(bars[1]).toHaveStyle({ width: '60%' });

    // Never a spinner in a table (DESIGN.md §8) — the ring carries `aria-label="Loading"`,
    // so its absence from the accessibility tree is the assertion.
    expect(screen.queryByRole('status', { name: /loading/i })).not.toBeInTheDocument();

    // The placeholders are `aria-hidden`, so without this the wait would be silent
    // (HIVE-2.5, #5284). One region, on the table, saying what is on its way.
    expect(container.querySelector('table')).toHaveAttribute('aria-busy', 'true');
    expect(screen.getByRole('status')).toHaveTextContent('Loading…');
  });

  it('names what is loading when the caller says so, and falls silent once it lands', () => {
    const { rerender } = render(
      <DataTable
        caption="Projects"
        columns={PROJECT_COLUMNS}
        rows={[]}
        getRowId={(project: Project) => project.id}
        loading
        loadingLabel="Loading projects…"
      />
    );
    expect(screen.getByRole('status')).toHaveTextContent('Loading projects…');

    rerender(
      <DataTable
        caption="Projects"
        columns={PROJECT_COLUMNS}
        rows={PROJECTS}
        getRowId={(project: Project) => project.id}
        loadingLabel="Loading projects…"
      />
    );
    // The region stays mounted and empties, so the reader hears the text *change* rather
    // than hearing a region disappear.
    expect(screen.getByRole('status')).toBeEmptyDOMElement();
  });

  it('offers a retry beside the failure, and calls back when it is pressed', () => {
    const onRetry = jest.fn();
    render(
      <DataTable
        caption="Projects"
        columns={PROJECT_COLUMNS}
        rows={[]}
        getRowId={(project: Project) => project.id}
        error="The API returned 502."
        onRetry={onRetry}
      />
    );

    // DESIGN.md §10: what happened, and what to do about it.
    const alert = screen.getByRole('alert');
    expect(alert).toHaveTextContent('The API returned 502.');
    fireEvent.click(screen.getByRole('button', { name: /Try again/i }));
    expect(onRetry).toHaveBeenCalledTimes(1);
  });

  it('shows the empty slot when there is nothing, and its own words when given none', () => {
    const { rerender } = render(
      <DataTable
        caption="Projects"
        columns={PROJECT_COLUMNS}
        rows={[]}
        getRowId={(project: Project) => project.id}
      />
    );
    expect(screen.getByText('Nothing to show yet.')).toBeInTheDocument();

    rerender(
      <DataTable
        caption="Projects"
        columns={PROJECT_COLUMNS}
        rows={[]}
        getRowId={(project: Project) => project.id}
        empty={<p>No projects match those filters.</p>}
      />
    );
    expect(screen.getByText('No projects match those filters.')).toBeInTheDocument();
  });

  it('shows the error slot as an alert, and keeps the header so the shape is still legible', () => {
    render(
      <DataTable
        caption="Projects"
        columns={PROJECT_COLUMNS}
        rows={[]}
        getRowId={(project: Project) => project.id}
        error="Could not load projects."
      />
    );

    expect(screen.getByRole('alert')).toHaveTextContent('Could not load projects.');
    expect(screen.getByRole('columnheader', { name: 'Project' })).toBeInTheDocument();
  });

  it('prefers loading to error, and error to empty', () => {
    render(
      <DataTable
        caption="Projects"
        columns={PROJECT_COLUMNS}
        rows={[]}
        getRowId={(project: Project) => project.id}
        loading
        error="Could not load projects."
      />
    );
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(screen.queryByText('Nothing to show yet.')).not.toBeInTheDocument();
  });

  it('spans the empty and error rows across every column, checkbox column included', () => {
    render(
      <DataTable
        caption="Projects"
        columns={PROJECT_COLUMNS}
        rows={[]}
        getRowId={(project: Project) => project.id}
        selectedIds={[]}
        onSelectionChange={jest.fn()}
      />
    );
    expect(screen.getByText('Nothing to show yet.').closest('td')).toHaveAttribute(
      'colspan',
      String(PROJECT_COLUMNS.length + 1)
    );
  });
});

describe('the foot', () => {
  it('says what is being shown, in the app’s one phrasing', () => {
    expect(dataTableRangeLabel(1, 25, 240, 'project')).toBe('Showing 1–25 of 240 projects');
    expect(dataTableRangeLabel(10, 25, 240, 'project')).toBe('Showing 226–240 of 240 projects');
    expect(dataTableRangeLabel(1, 25, 1, 'project')).toBe('Showing 1–1 of 1 project');
    expect(dataTableRangeLabel(1, 25, 0, 'project')).toBe('No projects');
  });

  it('elides a long page run rather than drawing forty buttons', () => {
    expect(dataTablePageWindow(1, 5)).toEqual([1, 2, null, 5]);
    expect(dataTablePageWindow(10, 40)).toEqual([1, null, 9, 10, 11, null, 40]);
    expect(dataTablePageWindow(1, 1)).toEqual([1]);
    expect(dataTablePageWindow(2, 3)).toEqual([1, 2, 3]);
  });

  it('is a named landmark, says which page you are on, and blocks the ends', async () => {
    const user = userEvent.setup();
    const onPageChange = jest.fn();
    render(<DataTablePager page={1} pageCount={4} onPageChange={onPageChange} />);

    const pager = screen.getByRole('navigation', { name: 'Pagination' });
    expect(within(pager).getByRole('button', { name: 'Page 1' })).toHaveAttribute(
      'aria-current',
      'page'
    );
    expect(within(pager).getByRole('button', { name: 'Previous page' })).toBeDisabled();

    await user.click(within(pager).getByRole('button', { name: 'Next page' }));
    expect(onPageChange).toHaveBeenCalledWith(2);
  });

  it('draws nothing at all when there is only one page', () => {
    render(<DataTablePager page={1} pageCount={1} onPageChange={jest.fn()} />);
    expect(screen.queryByRole('navigation')).not.toBeInTheDocument();
  });
});

describe('the toolbar', () => {
  it('is a search field, filter chips and whatever the page puts after the spacer', async () => {
    const user = userEvent.setup();
    const onChipClick = jest.fn();

    render(
      <DataTableToolbar>
        <DataTableSearch aria-label="Filter API keys" placeholder="Filter by name or prefix…" />
        <DataTableFilterChip active count={2} onClick={onChipClick}>
          Active
        </DataTableFilterChip>
        <DataTableFilterChip count={1}>Revoked</DataTableFilterChip>
        <DataTableToolbarSpacer />
        <Button size="sm" variant="ghost">
          Export CSV
        </Button>
      </DataTableToolbar>
    );

    expect(screen.getByRole('searchbox', { name: 'Filter API keys' })).toBeInTheDocument();

    const active = screen.getByRole('button', { name: /Active/ });
    expect(active).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByRole('button', { name: /Revoked/ })).toHaveAttribute(
      'aria-pressed',
      'false'
    );

    await user.click(active);
    expect(onChipClick).toHaveBeenCalled();
  });

  it('has no axe violations', async () => {
    const { container } = render(
      <DataTableToolbar>
        <DataTableSearch aria-label="Filter projects" />
        <DataTableFilterChip active>All</DataTableFilterChip>
        <DataTableToolbarSpacer />
      </DataTableToolbar>
    );
    expect(await axe(container)).toHaveNoViolations();
  });
});

describe('the row', () => {
  it('marks a selected row for the stylesheet, and unmarks it again', async () => {
    const user = userEvent.setup();
    ProjectsTable();

    await user.click(screen.getByRole('checkbox', { name: 'Select Payments API' }));
    expect(bodyRows()[0]).toHaveAttribute('data-selected');

    await user.click(screen.getByRole('checkbox', { name: 'Select Payments API' }));
    expect(bodyRows()[0]).not.toHaveAttribute('data-selected');
  });

  it('carries the page’s own row tint — the mockups’ deleted and expired rows', () => {
    ProjectsTable({
      rowClassName: (project) => (project.status === 'Deleted' ? 'is-deleted' : undefined),
    });
    expect(bodyRows()[3]).toHaveClass('is-deleted');
    expect(bodyRows()[0]).not.toHaveClass('is-deleted');
  });

  it('keeps its row actions in the accessibility tree while they are visually hidden', () => {
    ProjectsTable();
    // Revealed by hover with `opacity`, never `hidden` — so the buttons keep their place in
    // the tab order and their names in the tree.
    expect(screen.getByRole('button', { name: 'Edit Payments API' })).toBeInTheDocument();
  });

  it('does not open a row when one of its actions is what was clicked', async () => {
    const user = userEvent.setup();
    const onActivate = jest.fn();
    ProjectsTable({ onActivate });

    await user.click(screen.getByRole('button', { name: 'Edit Payments API' }));
    expect(onActivate).not.toHaveBeenCalled();
  });

  it('is not clickable at all when the page gave it nowhere to go', () => {
    render(
      <DataTable caption="Catalog" columns={CATALOG_COLUMNS} rows={CATALOG} getRowId={(c) => c.id} />
    );
    expect(bodyRows()[0]).not.toHaveClass('cursor-pointer');
  });
});

describe('sizing follows the preferences, never a frozen number', () => {
  it('re-points the row metric at the control height for a dense table', () => {
    const { container, rerender } = render(
      <DataTable
        caption="Projects"
        columns={PROJECT_COLUMNS}
        rows={PROJECTS}
        getRowId={(project: Project) => project.id}
        dense
      />
    );

    // A dense row is "as tall as a button" at both densities, rather than a second frozen
    // height that the density and font-scale preferences would not reach. The class carries
    // the derived cell paddings too — see the `.table-dense` block in globals.css, and the
    // measured case in `e2e/hive-data-table.spec.ts`.
    const card = container.querySelector('.table-density');
    expect(card).toHaveClass('table-dense');

    rerender(
      <DataTable
        caption="Projects"
        columns={PROJECT_COLUMNS}
        rows={PROJECTS}
        getRowId={(project: Project) => project.id}
      />
    );
    expect(container.querySelector('.table-density')).not.toHaveClass('table-dense');
  });

  it('puts the density hook on the card, so the HIVE-1.6 cell rhythm reaches every cell', () => {
    const { container } = render(
      <DataTable
        caption="Projects"
        columns={PROJECT_COLUMNS}
        rows={PROJECTS}
        getRowId={(project: Project) => project.id}
      />
    );
    expect(container.querySelector('.table-density')).toBeInTheDocument();
  });
});
