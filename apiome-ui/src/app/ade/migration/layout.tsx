'use client';

import '../../globals.css';
import * as React from 'react';
import AdeAppShell from '@/app/components/shell/AdeAppShell';
import { MigrationProvider, useMigration } from './MigrationContext';
import MigrationHeader from './components/MigrationHeader';
import MigrationSidebar from './components/MigrationSidebar';

/**
 * The migration tool's own furniture: a toolbar, an optional diff sidebar, and the page.
 *
 * All three are in normal flow. Until HIVE-3.8 (#5294) the toolbar was `position: fixed` at
 * `top: 48` and this column was `calc(100vh - 48px)` tall with a matching `margin-top`,
 * because a fixed 48px `TopHeader` sat above it. That header is gone and the route renders
 * inside the Hive `AppShell` instead, whose `<main>` is a flex column that already gives this
 * layout its box — so the toolbar is simply the first row of it.
 */
function MigrationLayoutInner({ children }: { children: React.ReactNode }) {
  const { fromVersionId, toVersionId } = useMigration();
  const showSidebar = !!fromVersionId && !!toVersionId && fromVersionId !== toVersionId;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', flex: 1, minHeight: 0 }}>
      <MigrationHeader />
      <div style={{ display: 'flex', flex: 1, overflow: 'hidden', minHeight: 0 }}>
        {showSidebar && <MigrationSidebar />}
        <main
          style={{
            flex: 1,
            overflow: 'auto',
            position: 'relative',
            display: 'flex',
            flexDirection: 'column',
          }}
        >
          {children}
        </main>
      </div>
    </div>
  );
}

/**
 * `/ade/migration/**` — Tools, inside the one chrome (HIVE-3.8, #5294).
 *
 * The rail is the platform's navigation on every `/ade` route but the launcher, so the
 * migration tool gets it too. Its own `MigrationSidebar` is unaffected: that is page
 * furniture, scoped to the chosen version pair, and it survives here until the deferred Tools
 * redesign replaces it.
 */
export default function MigrationLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <AdeAppShell>
      <MigrationProvider>
        <MigrationLayoutInner>{children}</MigrationLayoutInner>
      </MigrationProvider>
    </AdeAppShell>
  );
}
