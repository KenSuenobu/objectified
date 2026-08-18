'use client';

import * as React from 'react';
import { Check, Copy, CircleAlert, KeyRound, Plus, Trash2 } from 'lucide-react';

import { Badge } from '@/app/components/ui/Badge';
import { Button } from '@/app/components/ui/Button';
import {
  DataTable,
  DataTableCellPrimary,
  DataTableCellSub,
  DataTableFilterChip,
  DataTableFoot,
  DataTableSearch,
  DataTableToolbar,
  type DataTableColumn,
  type DataTableSortState,
} from '@/app/components/ui/DataTable';
import { EmptyState } from '@/app/components/ui/EmptyState';
import { Switch } from '@/app/components/ui/Switch';
import { useClipboardCopy } from '@/app/hooks/useClipboardCopy';

import {
  apiKeyFacetCounts,
  apiKeyRowActions,
  apiKeyScopeList,
  apiKeyStatus,
  copyableApiKeyPrefix,
  describeApiKeyBreakdown,
  displayApiKeyPrefix,
  formatApiKeyDate,
  formatApiKeyTimestamp,
  isApiKeyExpired,
  isFullAccessKey,
  matchesApiKeyFacet,
  searchApiKeys,
  sortApiKeys,
  summariseApiKeys,
  API_KEY_FACETS,
  API_KEY_FACET_LABELS,
  API_KEY_STATUS_LABEL,
  type ApiKeyFacet,
  type ApiKeyRecord,
} from './apiKeysModel';

/**
 * The keys list — HIVE-5.4 (#5307).
 *
 * Authority: `docs/mockups/workspace/api-keys.html`, the `.table-wrap` section; DESIGN.md §8
 * (list page) and §3.1 (the shared status vocabulary).
 *
 * ### What changed from the screen this replaces
 *
 * The old table was nine hand-built columns over `dashboardScreenClasses`, with three
 * inline-composed status pills (`bg-emerald-50`, `bg-red-50`, `bg-gray-100`), row tints in
 * `bg-red-50/50` and `bg-gray-50/80`, and no way to find a key among twenty. It is now
 * {@link DataTable}, which brings the sticky caps header, sortable columns, the skeleton, the
 * in-card empty state and the row-hover actions; the toolbar and the foot are the mockup's
 * additions.
 *
 * ### The two things this rewrite fixes rather than restyles
 *
 * 1. **An expired key still offered its switch.** Turning it back on wrote `enabled = true`
 *    and changed nothing a caller would notice, because expiry is checked separately when
 *    the key authenticates. The switch on an expired row is now inert and says why — the
 *    ticket's "expired and revoked keys are … non-actionable".
 * 2. **The prefix was drawn with two ellipses.** `key_prefix` is stored with a literal `...`
 *    appended, and the cell appended a typographic one on top of it. The prefix is now
 *    printed once and is copyable — without the ellipsis, so what lands on the clipboard is
 *    what a log search wants.
 *
 * ### One deliberate departure from the mockup
 *
 * The mockup fades a disabled row's ink to `--fg-muted`. Rows are tinted here and the ink is
 * left alone, for the reason HIVE-4.8 measured and 5.1 and 5.2 both restate: dimming text is
 * the one way to make a row distinct that can fail a contrast check. The Disabled badge is
 * what says a key is off.
 */

/** Props for {@link ApiKeysTable}. */
export interface ApiKeysTableProps {
  /** Every key of the tenant. */
  keys: readonly ApiKeyRecord[];
  /** True while the first read is in flight. */
  loading?: boolean;
  /** Why the list could not be read. Replaces the body with a retry. */
  error?: string | null;
  /** Retry the read. */
  onRetry?: () => void;
  /** The key a write is running against, so only that row's controls go inert. */
  busyKeyId?: string | null;
  /** Ask to enable or disable a key. Disabling is confirmed by the caller. */
  onToggleEnabled: (key: ApiKeyRecord, next: boolean) => void;
  /** Ask to delete a key. Confirmed by the caller. */
  onDelete: (key: ApiKeyRecord) => void;
  /** Open the create dialog, from the empty state. */
  onCreate: () => void;
  /**
   * The moment status is judged against.
   *
   * Injected so the suite can place a key either side of its expiry without waiting; the
   * page passes the time of its last load.
   */
  now?: Date;
}

/**
 * The copy-prefix button of one row.
 *
 * A component rather than a callback because the "copied" acknowledgement belongs to the one
 * button that was pressed — a single flag on the table would light up all of them.
 *
 * @param props.prefix The key's stored prefix.
 * @param props.name The key's name, for the button's accessible name.
 * @returns The button.
 */
function CopyPrefixButton({ prefix, name }: { prefix: string; name: string }) {
  const { copied, copy } = useClipboardCopy();
  return (
    <Button
      variant="ghost"
      size="sm"
      className="akey-prefix-copy"
      title={copied ? 'Copied!' : 'Copy prefix'}
      aria-label={copied ? `Copied the prefix of ${name}` : `Copy the prefix of ${name}`}
      onClick={() => void copy(copyableApiKeyPrefix(prefix))}
    >
      {copied ? <Check aria-hidden /> : <Copy aria-hidden />}
    </Button>
  );
}

/**
 * The keys list, its toolbar, its foot and its per-row controls.
 *
 * @param props See {@link ApiKeysTableProps}.
 * @returns The table card.
 */
export default function ApiKeysTable({
  keys,
  loading = false,
  error = null,
  onRetry,
  busyKeyId = null,
  onToggleEnabled,
  onDelete,
  onCreate,
  now,
}: ApiKeysTableProps) {
  const [query, setQuery] = React.useState('');
  const [facet, setFacet] = React.useState<ApiKeyFacet>('all');
  const [sort, setSort] = React.useState<DataTableSortState | null>(null);

  // One `Date` for the whole render, so the status a row's badge shows, the tint its `<tr>`
  // carries and the chip that counted it cannot be judged against three different moments.
  const at = React.useMemo(() => now ?? new Date(), [now]);

  const searched = React.useMemo(() => searchApiKeys(keys, query), [keys, query]);
  const counts = React.useMemo(() => apiKeyFacetCounts(searched, at), [searched, at]);
  const visible = React.useMemo(
    () => sortApiKeys(searched.filter((key) => matchesApiKeyFacet(key, facet, at)), sort, at),
    [searched, facet, sort, at]
  );
  const summary = React.useMemo(() => summariseApiKeys(keys, at), [keys, at]);
  const narrowed = query.trim().length > 0 || facet !== 'all';

  const columns = React.useMemo<DataTableColumn<ApiKeyRecord>[]>(
    () => [
      {
        id: 'name',
        header: 'Name',
        sortable: true,
        cell: (key) => (
          <div className="akey-identity" data-testid="api-key-row" data-api-key-name={key.name}>
            <span className="tnt-icon-tile" data-tone={isApiKeyExpired(key, at) ? 'danger' : 'honey'}>
              <KeyRound aria-hidden />
            </span>
            <span className="akey-identity__text">
              <DataTableCellPrimary className="akey-identity__name">
                {key.name}
              </DataTableCellPrimary>
              {key.description ? (
                <DataTableCellSub className="akey-identity__desc">
                  {key.description}
                </DataTableCellSub>
              ) : null}
            </span>
          </div>
        ),
        skeletonWidth: '11rem',
      },
      {
        id: 'prefix',
        header: 'Prefix',
        sortable: true,
        cell: (key) => (
          <span className="akey-prefix">
            <code className="akey-prefix__value mono">{displayApiKeyPrefix(key.key_prefix)}</code>
            <CopyPrefixButton prefix={key.key_prefix} name={key.name} />
          </span>
        ),
        skeletonWidth: '7rem',
      },
      {
        id: 'scopes',
        header: 'Scopes',
        sortable: true,
        cell: (key) =>
          isFullAccessKey(key) ? (
            <span className="akey-scopes__full">Full access</span>
          ) : (
            <span className="akey-scopes">
              {apiKeyScopeList(key).map((scope) => (
                <Badge key={scope} variant="accent" mono>
                  {scope}
                </Badge>
              ))}
            </span>
          ),
        skeletonWidth: '6rem',
      },
      {
        id: 'status',
        header: 'Status',
        sortable: true,
        cell: (key) => {
          const status = apiKeyStatus(key, at);
          return (
            <Badge status={status} dot={status !== 'expired'}>
              {status === 'expired' && <CircleAlert aria-hidden />}
              {API_KEY_STATUS_LABEL[status]}
            </Badge>
          );
        },
        skeletonWidth: '4.5rem',
      },
      {
        id: 'lastUsed',
        header: 'Last used',
        sortable: true,
        cell: (key) => (
          <span className="akey-stamp">{formatApiKeyTimestamp(key.last_used_at)}</span>
        ),
        skeletonWidth: '7rem',
      },
      {
        id: 'created',
        header: 'Created',
        sortable: true,
        cell: (key) => <span className="akey-stamp">{formatApiKeyTimestamp(key.created_at)}</span>,
        skeletonWidth: '7rem',
      },
      {
        id: 'expires',
        header: 'Expires',
        sortable: true,
        cell: (key) => (
          <span
            className={isApiKeyExpired(key, at) ? 'akey-stamp akey-stamp--past' : 'akey-stamp'}
          >
            {formatApiKeyDate(key.expires_at)}
          </span>
        ),
        skeletonWidth: '4.5rem',
      },
      {
        id: 'enabled',
        header: 'Enabled',
        sortable: true,
        cell: (key) => {
          const actions = apiKeyRowActions(key, at);
          const inert = !actions.canToggle || busyKeyId === key.id;
          return (
            <span className="akey-toggle" title={actions.toggleDisabledReason ?? undefined}>
              <Switch
                checked={key.enabled}
                disabled={inert}
                aria-label={`Enabled: ${key.name}`}
                data-testid={`api-key-toggle-${key.id}`}
                onCheckedChange={(next) => onToggleEnabled(key, next)}
              />
              <span className="akey-toggle__label">{key.enabled ? 'On' : 'Off'}</span>
            </span>
          );
        },
        skeletonWidth: '3.5rem',
      },
      {
        id: 'actions',
        headerLabel: 'Actions',
        actions: true,
        cell: (key) => (
          <Button
            variant="ghost"
            size="sm"
            className="px-1.5"
            disabled={busyKeyId === key.id}
            title="Delete API key"
            aria-label={`Delete ${key.name}`}
            data-testid={`api-key-delete-${key.id}`}
            onClick={() => onDelete(key)}
          >
            <Trash2 aria-hidden />
          </Button>
        ),
        skeletonWidth: '2rem',
      },
    ],
    [at, busyKeyId, onDelete, onToggleEnabled]
  );

  return (
    <DataTable
      columns={columns}
      rows={visible}
      getRowId={(key) => key.id}
      getRowLabel={(key) => key.name}
      caption="API keys for this workspace"
      scrollX
      loading={loading}
      loadingLabel="Loading API keys…"
      error={error}
      onRetry={onRetry}
      sort={sort}
      onSortChange={setSort}
      rowClassName={(key) => {
        const status = apiKeyStatus(key, at);
        if (status === 'expired') return 'akey-row--expired';
        if (status === 'disabled') return 'akey-row--disabled';
        return undefined;
      }}
      data-testid="api-keys-table"
      toolbar={
        <DataTableToolbar>
          <DataTableSearch
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Filter by name or prefix…"
            aria-label="Filter API keys"
          />
          {API_KEY_FACETS.map((entry) => (
            <DataTableFilterChip
              key={entry}
              active={facet === entry}
              count={counts[entry]}
              onClick={() => setFacet(entry)}
            >
              {API_KEY_FACET_LABELS[entry]}
            </DataTableFilterChip>
          ))}
        </DataTableToolbar>
      }
      empty={
        narrowed ? (
          <EmptyState
            variant="compact"
            icon={<KeyRound aria-hidden />}
            title="No API keys match these filters"
            description="Clear the search box or pick a different status."
            action={
              <Button
                variant="outline"
                size="sm"
                onClick={() => {
                  setQuery('');
                  setFacet('all');
                }}
              >
                Clear filters
              </Button>
            }
          />
        ) : (
          <EmptyState
            icon={<KeyRound aria-hidden />}
            title="No API keys yet"
            description="Create your first API key to reach this tenant's data over the REST API. Scoped CI tokens can only read diffs and lint gates."
            action={
              <Button onClick={onCreate}>
                <Plus aria-hidden />
                Create API key
              </Button>
            }
          />
        )
      }
      footer={
        <DataTableFoot>
          <span data-testid="api-keys-summary">{describeApiKeyBreakdown(summary)}</span>
          <span className="akey-foot-legend">
            Scopes: <code className="mono">*</code> (full), <code className="mono">diff:read</code>,{' '}
            <code className="mono">lint:read</code> — <code className="mono">*</code> must stand
            alone.
          </span>
        </DataTableFoot>
      }
    />
  );
}
