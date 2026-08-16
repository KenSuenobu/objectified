'use client';

import { usePathname } from 'next/navigation';
import TopHeader from './TopHeader';
import { suppressesTopHeader } from '@/app/components/shell/appShellRoutes';

/**
 * The legacy top bar, on the routes that still have one.
 *
 * Two surfaces draw their own chrome and must not have a second one above it: the `/ade`
 * launcher, which has never had the bar, and — since HIVE-3.1 (#5287) — every route inside
 * the Hive `AppShell`, whose rail replaces it outright (`DESIGN.md` §5.1). What is left is
 * Tools (`/ade/database`, `/ade/migration`) and the commercial studio surface, which keep
 * the header until their own epics migrate them; HIVE-3.8 (#5294) deletes this component
 * and `TopHeader` with it.
 *
 * @returns The top header, or nothing on a route that owns its chrome.
 */
export default function ConditionalHeader() {
  const pathname = usePathname();

  if (suppressesTopHeader(pathname)) {
    return null;
  }

  return <TopHeader />;
}
