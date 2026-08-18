'use client';

import * as React from 'react';
import { Plus } from 'lucide-react';

import { Button } from '@/app/components/ui/Button';
import { DataTableSearch } from '@/app/components/ui/DataTable';
import { Skeleton } from '@/app/components/ui/Skeleton';

import { RoleIcon } from './RoleIcon';
import { filterRoles, partitionRoles } from './rolesModel';
import type { RoleRecord } from '../access/accessApi';

/**
 * The role list — HIVE-5.3 (#5306).
 *
 * Authority: `docs/mockups/workspace/roles.html`, the `<aside>` beside the editor.
 *
 * ### Why this is a list of buttons and not a listbox
 *
 * The mockup marks it up as two `role="listbox"`es of `role="option"` buttons. A listbox
 * owes its reader arrow-key navigation and a roving tabindex, and the mockup provides
 * neither — so the roles for that pattern would be a promise the markup does not keep. What
 * this actually is, is master/detail: choosing a role changes what the pane beside it is
 * about. So it is an ordinary list of buttons, each `aria-current` when it is the one being
 * edited, which is reachable by Tab, announced correctly, and honest.
 */

/** Props for {@link RolesList}. */
export interface RolesListProps {
  /** Every role in the tenant, in the order the API returned them. */
  roles: readonly RoleRecord[];
  /** The role being edited, or `null`. */
  selectedId: string | null;
  /** Called with the role the reader chose; the page decides whether the switch happens. */
  onSelect: (role: RoleRecord) => void;
  /** Offer "New custom role" at the foot of the list. */
  canCreate: boolean;
  /** Open the new-role dialog. */
  onCreate: () => void;
  /** The role with unsaved changes, so its row can carry the honey dot. */
  dirtyRoleId?: string | null;
  /** Draw placeholders instead of rows. */
  loading?: boolean;
}

/** Props for one row. */
interface RoleRowProps {
  role: RoleRecord;
  selected: boolean;
  dirty: boolean;
  onSelect: (role: RoleRecord) => void;
}

/**
 * One role in the list.
 *
 * @param props See {@link RoleRowProps}.
 * @returns The row button.
 */
function RoleRow({ role, selected, dirty, onSelect }: RoleRowProps) {
  const count = role.member_count ?? 0;
  return (
    <li>
      <button
        type="button"
        className="rol-item"
        aria-current={selected ? 'true' : undefined}
        data-testid={`role-item-${role.slug}`}
        onClick={() => onSelect(role)}
      >
        <span className="tnt-icon-tile" aria-hidden>
          <RoleIcon role={role} />
        </span>
        <span className="rol-item__text">
          <span className="rol-item__name">
            <span className="rol-item__label">{role.name}</span>
            {dirty && <span className="rol-dot" aria-hidden data-testid="role-dirty-dot" />}
            {dirty && <span className="sr-only">Unsaved changes</span>}
          </span>
          <span className="rol-item__sub">{role.is_builtin ? 'Built-in' : 'Custom'}</span>
        </span>
        <span className="rol-item__count">
          {count}
          <span className="sr-only"> {count === 1 ? 'member' : 'members'}</span>
        </span>
      </button>
    </li>
  );
}

/**
 * The list of roles, grouped built-in then custom.
 *
 * @param props See {@link RolesListProps}.
 * @returns The filter box, the two groups, and the create affordance.
 */
export default function RolesList({
  roles,
  selectedId,
  onSelect,
  canCreate,
  onCreate,
  dirtyRoleId = null,
  loading = false,
}: RolesListProps) {
  const [query, setQuery] = React.useState('');
  const visible = React.useMemo(() => filterRoles(roles, query), [roles, query]);
  const { builtin, custom } = React.useMemo(() => partitionRoles(visible), [visible]);

  /**
   * One titled group, or nothing when the filter emptied it.
   *
   * @param title The group's caption.
   * @param group The roles in it.
   * @returns The group, or `null`.
   */
  const renderGroup = (title: string, group: RoleRecord[]) =>
    group.length === 0 ? null : (
      <div>
        <p className="tnt-caps px-3 pb-1.5">{title}</p>
        <ul className="rol-list" aria-label={`${title} roles`}>
          {group.map((role) => (
            <RoleRow
              key={role.id}
              role={role}
              selected={role.id === selectedId}
              dirty={role.id === dirtyRoleId}
              onSelect={onSelect}
            />
          ))}
        </ul>
      </div>
    );

  return (
    <aside className="flex flex-col gap-3" aria-label="Roles">
      <DataTableSearch
        aria-label="Filter roles"
        placeholder="Filter roles…"
        className="w-full"
        value={query}
        onChange={(event) => setQuery(event.target.value)}
      />

      {loading ? (
        <div className="flex flex-col gap-2" data-testid="roles-list-loading">
          {[0, 1, 2, 3].map((row) => (
            <Skeleton key={row} className="h-11 w-full rounded-md" />
          ))}
        </div>
      ) : (
        <>
          {renderGroup('Built-in', builtin)}
          {renderGroup('Custom', custom)}
          {visible.length === 0 && (
            <p className="px-3 text-sm text-fg-muted" data-testid="roles-filter-empty">
              No role matches “{query.trim()}”.
            </p>
          )}
        </>
      )}

      {canCreate && (
        <Button variant="ghost" size="sm" className="justify-start" onClick={onCreate}>
          <Plus aria-hidden />
          New custom role
        </Button>
      )}
    </aside>
  );
}
