'use client';

import '../../globals.css';
import * as React from 'react';
import AdeAppShell from '@/app/components/shell/AdeAppShell';
import { DatabaseProvider, useDatabase } from './DatabaseContext';
import DatabaseHeader from './components/DatabaseHeader';
import TablesSidebar from './components/TablesSidebar';

/**
 * The data browser's own furniture: a toolbar, an optional tables sidebar, and the page.
 *
 * All three are in normal flow. Until HIVE-3.8 (#5294) the toolbar was `position: fixed` at
 * `top: 48` and this column was `calc(100vh - 48px)` tall with a matching `margin-top`,
 * because a fixed 48px `TopHeader` sat above it. That header is gone and the route renders
 * inside the Hive `AppShell` instead, whose `<main>` is a flex column that already gives this
 * layout its box — so the toolbar is simply the first row of it.
 */
function DatabaseLayoutInner({ children }: { children: React.ReactNode }) {
  const { selectedProjectId, selectedVersionId } = useDatabase();
  return (
    <div style={{ display: 'flex', flexDirection: 'column', flex: 1, minHeight: 0 }}>
      <DatabaseHeader />
      <div style={{ display: 'flex', flex: 1, overflow: 'hidden', minHeight: 0 }}>
        {selectedProjectId && selectedVersionId && <TablesSidebar />}
        <main
          style={{
            flex: 1,
            overflow: 'hidden',
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
 * `/ade/database/**` — Tools, inside the one chrome (HIVE-3.8, #5294).
 *
 * The rail is the platform's navigation on every `/ade` route but the launcher, so the data
 * browser gets it too. Its own `TablesSidebar` is unaffected: that is page furniture, scoped
 * to the selected version, and it survives here until the deferred Tools redesign replaces it.
 */
export default function DatabaseLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <AdeAppShell>
      <DatabaseProvider>
        <DatabaseLayoutInner>{children}</DatabaseLayoutInner>
      </DatabaseProvider>
    </AdeAppShell>
  );
}
