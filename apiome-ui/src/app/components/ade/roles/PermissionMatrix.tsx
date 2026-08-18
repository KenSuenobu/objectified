'use client';

import * as React from 'react';
import { Check, Eraser, Eye, Globe, Grid3x3, Minus, Pencil, Plus, Trash2 } from 'lucide-react';

import { Button } from '@/app/components/ui/Button';

import {
  ACTIONS,
  RESOURCES,
  cellKey,
  describeCellsOn,
  resourceState,
  type PermissionGrid,
} from './rolesModel';

/**
 * The permission matrix — HIVE-5.3 (#5306).
 *
 * Authority: `docs/mockups/workspace/roles.html`, the `.matrix` table and its `.perm` cells.
 *
 * ### What this replaces
 *
 * A raw `<table>` of 24 px `<button>`s whose granted state was a green Tailwind fill written
 * inline, whose ungranted state was a transparent check the reader could not see, and which
 * offered no way to fill a row or a column. Thirteen resources times five actions is 65
 * decisions; the old screen made every one of them a separate click and gave the reader no
 * summary of how many they had made.
 *
 * ### The tri-state row toggle
 *
 * Each resource's own name is a toggle for its five cells, and it is the one control here
 * that can be *partly* on — `aria-pressed="mixed"`, the third state the mockup's `.perm`
 * stylesheet defines and its markup never reaches. A single cell cannot be partly granted;
 * a row can, and a row is how a grid this size is actually filled in.
 *
 * ### Accessible names
 *
 * Every toggle names itself in full — "Projects View", "All Versions permissions" — rather
 * than relying on the column header, because a `<th>` only names a cell for a screen reader
 * that is in table-navigation mode, and these are buttons a reader reaches with Tab.
 */

/** The glyph beside each action's column heading, keyed by action. */
const ACTION_ICON: Readonly<Record<string, React.ComponentType<{ 'aria-hidden'?: boolean }>>> = {
  view: Eye,
  create: Plus,
  edit: Pencil,
  delete: Trash2,
  publish: Globe,
};

/** Props for {@link PermissionMatrix}. */
export interface PermissionMatrixProps {
  /** The cells currently granted, as `resource:action` keys. */
  grid: PermissionGrid;
  /** Whether the reader may change anything; `false` renders every toggle locked. */
  editable: boolean;
  /** Turn one cell on or off. */
  onToggleCell: (resource: string, action: string) => void;
  /** Turn a whole resource row on or off. */
  onToggleResource: (resource: string) => void;
  /** Grant one action on every resource — the "Grant view on all" helper. */
  onGrantActionEverywhere: (action: string) => void;
  /** Turn every cell off. */
  onClearAll: () => void;
}

/**
 * One toggle cell.
 *
 * @param props.pressed `true`, `false`, or `'mixed'` for a partly granted row.
 * @param props.label The button's accessible name.
 * @param props.disabled Whether it is locked.
 * @param props.onClick What pressing it does.
 * @returns The button.
 */
function PermToggle({
  pressed,
  label,
  disabled,
  onClick,
  testId,
}: {
  pressed: boolean | 'mixed';
  label: string;
  disabled: boolean;
  onClick: () => void;
  testId?: string;
}) {
  return (
    <button
      type="button"
      className="rol-perm"
      aria-pressed={pressed}
      aria-label={label}
      disabled={disabled}
      data-testid={testId}
      onClick={onClick}
    >
      {pressed === 'mixed' ? <Minus aria-hidden /> : <Check aria-hidden />}
    </button>
  );
}

/**
 * The matrix, its counter and its two bulk helpers.
 *
 * @param props See {@link PermissionMatrixProps}.
 * @returns The header row and the scrollable table.
 */
export default function PermissionMatrix({
  grid,
  editable,
  onToggleCell,
  onToggleResource,
  onGrantActionEverywhere,
  onClearAll,
}: PermissionMatrixProps) {
  return (
    <>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="flex items-center gap-2 text-sm text-fg-muted">
          <Grid3x3 className="size-[var(--icon-dense)] shrink-0" aria-hidden />
          Permission matrix
          <span aria-hidden>·</span>
          <span className="tabular-nums" data-testid="roles-cells-on">
            {describeCellsOn(grid)}
          </span>
        </p>
        {editable && (
          <div className="flex flex-wrap items-center gap-2">
            <Button variant="ghost" size="sm" onClick={() => onGrantActionEverywhere('view')}>
              <Eye aria-hidden />
              Grant view on all
            </Button>
            <Button variant="ghost" size="sm" onClick={onClearAll}>
              <Eraser aria-hidden />
              Clear all
            </Button>
          </div>
        )}
      </div>

      <div className="rol-matrix-wrap">
        <table className="rol-matrix">
          <caption className="sr-only">
            Permissions this role grants, by resource and action
          </caption>
          <thead>
            <tr>
              <th scope="col">Resource</th>
              {ACTIONS.map((action) => {
                const Icon = ACTION_ICON[action.key];
                return (
                  <th key={action.key} scope="col">
                    <span>
                      {Icon && <Icon aria-hidden />}
                      {action.label}
                    </span>
                  </th>
                );
              })}
            </tr>
          </thead>
          <tbody>
            {RESOURCES.map((resource) => (
              <tr key={resource.key}>
                <th scope="row" className="font-normal">
                  <span className="rol-res">
                    <PermToggle
                      pressed={resourceState(grid, resource.key)}
                      label={`All ${resource.label} permissions`}
                      disabled={!editable}
                      testId={`role-row-${resource.key}`}
                      onClick={() => onToggleResource(resource.key)}
                    />
                    <span>
                      <span className="rol-res__name">{resource.label}</span>
                      <span className="rol-res__key mono">{resource.key}</span>
                    </span>
                  </span>
                </th>
                {ACTIONS.map((action) => (
                  <td key={action.key}>
                    <PermToggle
                      pressed={grid.has(cellKey(resource.key, action.key))}
                      label={`${resource.label} ${action.label}`}
                      disabled={!editable}
                      testId={`role-cell-${resource.key}-${action.key}`}
                      onClick={() => onToggleCell(resource.key, action.key)}
                    />
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}
