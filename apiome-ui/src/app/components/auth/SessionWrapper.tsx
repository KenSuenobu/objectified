'use client';

import { AuthSessionProvider } from '@lib/auth/session-client';
import React from 'react';

/**
 * App-wide session provider (OLO-10.12). Wraps the tree in `AuthSessionProvider`
 * (the Better Auth session layer) — the replacement for NextAuth's `SessionProvider`.
 */
const SessionWrapper = ({ children }: { children: React.ReactNode }) => {
    return <AuthSessionProvider>{children}</AuthSessionProvider>;
};

export default SessionWrapper;
