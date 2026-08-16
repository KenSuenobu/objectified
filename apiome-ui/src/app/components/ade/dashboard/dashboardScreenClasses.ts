/** Shared layout tokens aligned with the Primitives dashboard screen.
 *  Scrolls inside the dashboard content pane (not the document / sidebar).
 *  `relative` is load-bearing: it makes the pane the containing block for absolutely
 *  positioned descendants (e.g. Tailwind `sr-only` elements deep in tall content), which
 *  otherwise anchor to the page root at their flow position and stretch the whole document.
 *
 *  Page padding, card padding and table cell rhythm are no longer frozen `p-6` / `p-4` /
 *  `py-3` values: they come from the HIVE-1.3 density preference through the `p-page`,
 *  `p-card` and `table-density` classes in `globals.css` (HIVE-1.6, #5279), so choosing
 *  Compact tightens every dashboard screen at once and the Largest font scale grows them
 *  all together. `table-density` reaches the cells each page writes for itself, which is
 *  why the shared `th` classes no longer carry a vertical padding of their own.
 *  Retired by HIVE-2.3's `DataTable`, which inherits the same classes. */
export const dashboardMainClass = 'relative min-h-0 flex-1 overflow-x-hidden overflow-y-auto p-page';
export const dashboardContentStackClass = 'space-y-6';

export const dashboardPanelClass =
  'bg-white dark:bg-gray-800 rounded-lg border border-gray-200 dark:border-gray-700';
export const dashboardPanelPaddedClass = `${dashboardPanelClass} p-card`;

export const dashboardTableWrapClass = `${dashboardPanelClass} table-density overflow-hidden`;

export const dashboardTableTheadClass =
  'bg-gray-50 dark:bg-gray-900 border-b border-gray-200 dark:border-gray-700';

export const dashboardThClass =
  'px-6 text-left text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wider';

export const dashboardThRightClass =
  'px-6 text-right text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wider';

export const dashboardTbodyClass = 'divide-y divide-gray-200 dark:divide-gray-700';

export const dashboardTrHoverClass =
  'hover:bg-gray-50 dark:hover:bg-gray-900/50 transition-colors';
