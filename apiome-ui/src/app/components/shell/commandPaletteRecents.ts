'use client';

import * as React from 'react';

/**
 * The command palette's **Recent** group, stored locally and scoped per workspace
 * (HIVE-3.6, #5292; `DESIGN.md` §5.4).
 *
 * Two rules decide everything in this module:
 *
 *  1. **Per tenant.** A reader in two workspaces has two histories, and a project name
 *     from one must never surface while they are working in the other — the palette would
 *     be offering a destination the API will refuse. The store is therefore a map keyed by
 *     tenant id, and reading with no tenant returns nothing rather than everything.
 *  2. **Local only.** The list is a convenience, not a record: it is written from the
 *     browser, never sent anywhere, and a storage-refusing browser (private mode, a
 *     hardened profile) simply gets a palette with no Recent group. Every read and write is
 *     therefore `try`/`catch`ed and every failure is silent, which is why nothing here
 *     throws.
 *
 * Anything the palette can open can be recorded, which is what makes this the seam the page
 * epics use: a project page that wants "Payments API · v2.4.0" in the palette calls
 * {@link recordCommandPaletteRecent} when it loads, and the entry appears with no change
 * here. The palette itself records what the reader opens *through* it, so the group is
 * useful from the first jump even before any page contributes.
 */

/** `localStorage` key holding every workspace's list. */
export const PALETTE_RECENTS_STORAGE_KEY = 'hive.paletteRecents';

/**
 * How many entries one workspace keeps.
 *
 * The palette shows the group above a footer on a 640 px dialog: past about five rows the
 * Recent group pushes Jump to and Actions off the first screen, which is the opposite of
 * what a palette is for. Older entries fall off the end rather than being pruned by age —
 * a reader who has not opened anything for a month should still find their last project.
 */
export const PALETTE_RECENTS_LIMIT = 5;

/** One remembered destination. */
export interface CommandPaletteRecent {
  /** Stable id, unique within a workspace; re-recording the same id moves it to the top. */
  id: string;
  /** What the row says — a project, a version, a section. */
  label: string;
  /** Where the row goes. In-app routes only: a recent is something to reopen. */
  href: string;
  /** The quiet second line: `v2.4.0 · draft`, or the section a destination lives in. */
  meta?: string;
  /** Lucide icon name, resolved by `lib/platform-nav-icons.ts` like any nav destination. */
  icon?: string;
  /** When it was last opened, epoch milliseconds — the sort key. */
  at: number;
}

/** The stored shape: tenant id → that workspace's entries, newest first. */
type RecentsByTenant = Record<string, CommandPaletteRecent[]>;

/**
 * Whether a parsed value is an entry this module wrote.
 *
 * Storage is shared with every other script on the origin and survives releases, so a value
 * that is not the current shape is discarded rather than rendered — a row with no `href` is
 * a dead row, and a row with no `label` is a blank one.
 *
 * @param value Anything parsed out of storage.
 * @returns True when the value can be used as a {@link CommandPaletteRecent}.
 */
function isRecent(value: unknown): value is CommandPaletteRecent {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as Partial<CommandPaletteRecent>;
  return (
    typeof candidate.id === 'string' &&
    candidate.id.length > 0 &&
    typeof candidate.label === 'string' &&
    candidate.label.length > 0 &&
    typeof candidate.href === 'string' &&
    candidate.href.length > 0 &&
    typeof candidate.at === 'number' &&
    Number.isFinite(candidate.at)
  );
}

/**
 * The whole store, or an empty one.
 *
 * @returns Every workspace's entries. Never throws; an unreadable or malformed store reads
 *   as empty, which is the same thing a first visit looks like.
 */
function readStore(): RecentsByTenant {
  if (typeof window === 'undefined') return {};

  try {
    const raw = window.localStorage.getItem(PALETTE_RECENTS_STORAGE_KEY);
    if (!raw) return {};

    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};

    const store: RecentsByTenant = {};
    for (const [tenantId, entries] of Object.entries(parsed as Record<string, unknown>)) {
      if (!Array.isArray(entries)) continue;
      store[tenantId] = entries.filter(isRecent);
    }
    return store;
  } catch {
    return {};
  }
}

/**
 * Replace the whole store.
 *
 * @param store Every workspace's entries.
 */
function writeStore(store: RecentsByTenant): void {
  if (typeof window === 'undefined') return;

  try {
    window.localStorage.setItem(PALETTE_RECENTS_STORAGE_KEY, JSON.stringify(store));
  } catch {
    // A browser that refuses storage gets a palette with no Recent group, which is a
    // working palette. Nothing else in the app depends on this succeeding.
  }
}

/**
 * One workspace's recent destinations, newest first.
 *
 * @param tenantId The active workspace. `null`/`undefined` returns an empty list: with no
 *   workspace there is nothing workspace-scoped to reopen.
 * @returns Up to {@link PALETTE_RECENTS_LIMIT} entries, newest first.
 */
export function readCommandPaletteRecents(
  tenantId: string | null | undefined
): CommandPaletteRecent[] {
  if (!tenantId) return [];

  return [...(readStore()[tenantId] ?? [])]
    .sort((left, right) => right.at - left.at)
    .slice(0, PALETTE_RECENTS_LIMIT);
}

/**
 * Remember a destination for this workspace, or move it back to the top.
 *
 * Recording is idempotent by `id`: reopening yesterday's project updates its timestamp and
 * its label rather than adding a second row for the same thing.
 *
 * @param tenantId The active workspace. With none, nothing is recorded — an entry with no
 *   workspace could never be shown again.
 * @param entry What was opened. `at` defaults to now.
 * @returns The workspace's list after the write, newest first.
 */
export function recordCommandPaletteRecent(
  tenantId: string | null | undefined,
  entry: Omit<CommandPaletteRecent, 'at'> & { at?: number }
): CommandPaletteRecent[] {
  if (!tenantId) return [];

  const recorded: CommandPaletteRecent = { ...entry, at: entry.at ?? Date.now() };
  if (!isRecent(recorded)) return readCommandPaletteRecents(tenantId);

  const store = readStore();
  const next = [recorded, ...(store[tenantId] ?? []).filter((row) => row.id !== recorded.id)]
    .sort((left, right) => right.at - left.at)
    .slice(0, PALETTE_RECENTS_LIMIT);

  writeStore({ ...store, [tenantId]: next });
  return next;
}

/**
 * Forget one workspace's history, or all of it.
 *
 * @param tenantId The workspace to clear. Omitted, the whole store goes — which is what a
 *   sign-out on a shared machine wants.
 */
export function clearCommandPaletteRecents(tenantId?: string | null): void {
  if (typeof window === 'undefined') return;

  if (!tenantId) {
    try {
      window.localStorage.removeItem(PALETTE_RECENTS_STORAGE_KEY);
    } catch {
      // See `writeStore`.
    }
    return;
  }

  const store = readStore();
  if (!(tenantId in store)) return;

  const next = { ...store };
  delete next[tenantId];
  writeStore(next);
}

/** What {@link useCommandPaletteRecents} hands back. */
export interface CommandPaletteRecents {
  /** This workspace's entries, newest first. */
  recents: CommandPaletteRecent[];
  /** Record a destination and refresh {@link recents}. */
  record: (entry: Omit<CommandPaletteRecent, 'at'> & { at?: number }) => void;
}

/**
 * One workspace's recent destinations, as React state.
 *
 * Reading starts empty and resolves in an effect rather than in a lazy initialiser, for the
 * reason `useWhatsNewUnread` does the same (HIVE-3.4): the server renders no storage, so an
 * initialiser that read it would paint rows on the client that the server's HTML does not
 * have, and React would report a hydration mismatch.
 *
 * @param tenantId The active workspace; changing it swaps the whole list.
 * @returns The entries and a recorder — see {@link CommandPaletteRecents}.
 */
export function useCommandPaletteRecents(
  tenantId: string | null | undefined
): CommandPaletteRecents {
  const [recents, setRecents] = React.useState<CommandPaletteRecent[]>([]);

  React.useEffect(() => {
    setRecents(readCommandPaletteRecents(tenantId));
  }, [tenantId]);

  const record = React.useCallback<CommandPaletteRecents['record']>(
    (entry) => {
      setRecents(recordCommandPaletteRecent(tenantId, entry));
    },
    [tenantId]
  );

  return { recents, record };
}
