/**
 * Which rail nav groups the reader has folded away (HIVE-3.1, #5287).
 *
 * `DESIGN.md` §5.2 makes the group headings click-to-collapse, and the mockup persists the
 * choice under `hive.navCollapsed` — the same `hive.*` device-local vocabulary the
 * preferences of HIVE-1.3 use, but deliberately *not* a preference: it is a per-group
 * scratch state with no pane row, no `<html>` attribute and no CSS to drive.
 *
 * Groups are stored by **id** (`build`, `bring-in`, …) rather than by heading, so renaming
 * a heading does not silently unfold a group the reader had put away. Every function here
 * tolerates a hostile store: a browser with storage disabled, a value written by another
 * build, or a string that is not JSON at all. The rail always renders; at worst it renders
 * with every group open.
 */

import type { PlatformNavGroupId } from '@lib/platform-nav';

/** Storage key, as `DESIGN.md` §5.2 and `docs/mockups/assets/hive.js` spell it. */
export const NAV_COLLAPSED_STORAGE_KEY = 'hive.navCollapsed';

/**
 * Read the folded groups.
 *
 * @returns Group ids that render folded, or an empty array when nothing is stored, the
 *          store cannot be read, or what is there is not a list of strings.
 */
export function readCollapsedNavGroups(): PlatformNavGroupId[] {
  if (typeof window === 'undefined') return [];

  try {
    const raw = window.localStorage.getItem(NAV_COLLAPSED_STORAGE_KEY);
    if (!raw) return [];

    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];

    return parsed.filter((entry): entry is PlatformNavGroupId => typeof entry === 'string');
  } catch {
    return [];
  }
}

/**
 * Persist the folded groups.
 *
 * A failure is swallowed on purpose: Safari's private mode throws on every write, and a
 * rail that cannot remember a folded group is still a working rail.
 *
 * @param groupIds Group ids that should render folded.
 */
export function writeCollapsedNavGroups(groupIds: readonly PlatformNavGroupId[]): void {
  if (typeof window === 'undefined') return;

  try {
    window.localStorage.setItem(NAV_COLLAPSED_STORAGE_KEY, JSON.stringify([...groupIds]));
  } catch {
    /* Storage unavailable — the fold lasts for this page view only. */
  }
}

/**
 * Fold or unfold one group.
 *
 * @param groupIds The currently folded ids.
 * @param groupId The group whose heading was clicked.
 * @returns A new list with `groupId` added when it was open, removed when it was folded.
 */
export function toggleCollapsedNavGroup(
  groupIds: readonly PlatformNavGroupId[],
  groupId: PlatformNavGroupId
): PlatformNavGroupId[] {
  return groupIds.includes(groupId)
    ? groupIds.filter((id) => id !== groupId)
    : [...groupIds, groupId];
}
