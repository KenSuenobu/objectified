'use client';

/**
 * The linked-accounts list (HIVE-4.8, #5302).
 *
 * Authority: `docs/mockups/account/linked-accounts.html` §"Linked accounts table" — Account ·
 * Linked · Last login · Actions, a toolbar naming the list, a foot counting it, and the
 * last-sign-in-method guard drawn twice.
 *
 * ### Why this is `DataTable` and not the table it was
 *
 * The page hand-rolled a `<table>` out of the string constants in `dashboardScreenClasses.ts` —
 * `dashboardThClass`, `dashboardTrHoverClass` and five more — which is the pattern HIVE-2.3
 * (#5282) replaced across forty screens. What it bought by hand it also had to build by hand,
 * and so it had none of it: no `<caption>`, no `scope`d headers, no keyboard row navigation, no
 * skeleton rows, and an empty state that replaced the whole card rather than sitting inside it.
 * All five arrive with the component.
 *
 * ### The guard is said three times, on purpose
 *
 * When an identity is the reader's only way in, the row carries the amber note, the button
 * carries the Keeps list's `title`, and the button is `aria-describedby` the note. The note is
 * the one a sighted reader sees without hovering, the `title` is the one the mockup fixes, and
 * the description is the one a screen reader hears — a disabled control with an explanation only
 * in a hover tooltip explains itself to nobody. The row also opts out of the hover-reveal, since
 * an action that is disabled *and* invisible reads as an action that is missing.
 */

import * as React from 'react';
import { Link as LinkIcon, Lock, TriangleAlert, Unlink } from 'lucide-react';

import { Badge } from '@/app/components/ui/Badge';
import { Button } from '@/app/components/ui/Button';
import {
  DataTable,
  DataTableCellPrimary,
  DataTableCellSub,
  DataTableFoot,
  DataTableToolbar,
  DataTableToolbarSpacer,
  type DataTableColumn,
} from '@/app/components/ui/DataTable';
import { EmptyState } from '@/app/components/ui/EmptyState';
import { ICON_SIZE } from '@/app/components/ui/iconSizes';
import { getProviderBrand } from '@/app/components/auth/provider-brand';
import { LAST_METHOD_NOTE, LAST_METHOD_TOOLTIP, type LinkedAccountRow } from './linkedAccountsModel';

/** What the table's `<caption>` and its toolbar call the list. */
const LIST_NAME = 'Linked accounts';

/** The em dash a never-signed-in row prints, rather than a blank cell. */
const NO_VALUE = '—';

/** Props for {@link LinkedAccountsTable}. */
export interface LinkedAccountsTableProps {
  /** The rows to draw, already composed by `buildLinkedAccountRows`. */
  rows: readonly LinkedAccountRow[];
  /** Whether the two lookups behind the list are in flight. */
  loading: boolean;
  /** Whether a usable password is set — the toolbar's "Password also set" hint. */
  hasPassword: boolean;
  /** Whether a write is in flight, which disables every Unlink. */
  busy: boolean;
  /** Called with the row whose Unlink was pressed. */
  onUnlink: (row: LinkedAccountRow) => void;
  /**
   * The empty state's one way out.
   *
   * Passed in rather than built here: the way out is a link to the provider grid *on the page*,
   * so the page owns the anchor and this component stays ignorant of its neighbours.
   */
  emptyAction?: React.ReactNode;
}

/**
 * The Account cell: the provider's mark, its name, the handle, and the guard note.
 *
 * @param props.row The row being drawn.
 * @param props.noteId `id` for the guard note, so the Unlink button can point at it.
 * @returns The cell contents.
 */
function AccountCell({ row, noteId }: { row: LinkedAccountRow; noteId: string }) {
  const { Icon } = getProviderBrand(row.provider);

  return (
    <div className="lnk-account">
      {/* The mark takes the tile's own token ink rather than its brand hue, for the reason
          `SignInMethodsCard` gives: in a list of identities the reader already has, the glyph
          is a bullet. The brand hues are spent on the provider *cards*, where a provider is
          being chosen. */}
      <span className="acct-glyph acct-glyph--sm" aria-hidden>
        <Icon size={ICON_SIZE.dense} />
      </span>
      <div className="lnk-account__body">
        <DataTableCellPrimary>{row.label}</DataTableCellPrimary>
        {row.handle ? (
          <DataTableCellSub className="lnk-account__handle">{row.handle}</DataTableCellSub>
        ) : null}
        {row.isLastSignInMethod ? (
          <p className="lnk-last-method" id={noteId}>
            <TriangleAlert aria-hidden />
            {LAST_METHOD_NOTE}
          </p>
        ) : null}
      </div>
    </div>
  );
}

/**
 * Draw the list.
 *
 * @param props See {@link LinkedAccountsTableProps}.
 * @returns The card, its toolbar, the table and its foot.
 */
export function LinkedAccountsTable({
  rows,
  loading,
  hasPassword,
  busy,
  onUnlink,
  emptyAction,
}: LinkedAccountsTableProps) {
  // One prefix per mounted table, so two tables on a page could never mint the same note id.
  const notePrefix = React.useId();

  /** The guard note's `id` for one row. */
  const noteIdFor = React.useCallback(
    (row: LinkedAccountRow) => `${notePrefix}-guard-${row.id}`,
    [notePrefix]
  );

  const columns = React.useMemo<Array<DataTableColumn<LinkedAccountRow>>>(
    () => [
      {
        id: 'account',
        header: 'Account',
        skeletonWidth: '9rem',
        cell: (row) => <AccountCell row={row} noteId={noteIdFor(row)} />,
      },
      {
        id: 'linked',
        header: 'Linked',
        skeletonWidth: '6rem',
        className: 'whitespace-nowrap tabular-nums text-fg-muted',
        cell: (row) => row.linkedAt ?? NO_VALUE,
      },
      {
        id: 'lastLogin',
        header: 'Last login',
        skeletonWidth: '6rem',
        className: 'whitespace-nowrap tabular-nums text-fg-muted',
        cell: (row) => row.lastLoginAt ?? NO_VALUE,
      },
      {
        id: 'actions',
        headerLabel: 'Actions',
        actions: true,
        align: 'end',
        cell: (row) => (
          <Button
            variant="danger-soft"
            size="sm"
            onClick={() => onUnlink(row)}
            disabled={busy || row.isLastSignInMethod}
            title={row.isLastSignInMethod ? LAST_METHOD_TOOLTIP : undefined}
            aria-describedby={row.isLastSignInMethod ? noteIdFor(row) : undefined}
            data-testid={`linked-unlink-${row.provider}`}
          >
            <Unlink aria-hidden />
            Unlink
          </Button>
        ),
      },
    ],
    [busy, noteIdFor, onUnlink]
  );

  return (
    <DataTable
      caption={LIST_NAME}
      columns={columns}
      rows={rows}
      getRowId={(row) => row.id}
      getRowLabel={(row) => `${row.label}${row.handle ? ` (${row.handle})` : ''}`}
      // Two of the four columns are timestamps that must not wrap, and the fourth holds a
      // button: below roughly a tablet the four together are wider than the viewport whatever
      // the Account cell does. `scrollX` is `DataTable`'s answer — the *card* scrolls, as a
      // keyboard-reachable region named by the caption, and the document never does.
      scrollX
      loading={loading}
      loadingLabel="Loading linked accounts…"
      skeletonRows={2}
      rowClassName={(row) => (row.isLastSignInMethod ? 'lnk-row--guarded' : undefined)}
      data-testid="linked-accounts-table"
      empty={
        <EmptyState
          variant="compact"
          surface={false}
          icon={<LinkIcon />}
          title="No linked accounts"
          titleAs="p"
          description="Link a provider below to sign in with SSO and manage repository access."
          action={emptyAction}
          data-testid="linked-accounts-empty"
        />
      }
      toolbar={
        <DataTableToolbar>
          <span className="text-sm font-semibold text-fg">{LIST_NAME}</span>
          <span className="text-xs text-fg-muted">Providers you can sign in with today</span>
          <DataTableToolbarSpacer />
          {hasPassword ? (
            <Badge variant="outline" size="lg" data-testid="linked-password-hint">
              <Lock aria-hidden />
              Password also set
            </Badge>
          ) : null}
        </DataTableToolbar>
      }
      footer={
        <DataTableFoot>
          {/* The count is withheld while the rows are placeholders: "0 linked accounts" under
              two skeleton rows is a statement the page does not yet know to be true. */}
          {loading ? (
            <span />
          ) : (
            <span data-testid="linked-accounts-count">
              {rows.length === 1 ? '1 linked account' : `${rows.length} linked accounts`}
            </span>
          )}
          {!loading && rows.length > 0 ? <span>Hover a row for actions</span> : null}
        </DataTableFoot>
      }
    />
  );
}

export default LinkedAccountsTable;
