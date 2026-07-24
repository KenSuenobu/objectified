'use client';

/**
 * Browser session layer (OLO-10.12 #5007; Better-Auth-only since the OLO-10.14 cutover #5009).
 *
 * The single entry point the UI uses in place of `next-auth/react` — no component imports
 * `next-auth/react`. It presents the legacy `{ data, status, update }` shape (so component bodies
 * barely change) while driving Better Auth's reactive client (`authClient.useSession()` for reads,
 * `authClient.*` for mutations, `better-auth-client-compat.ts`).
 *
 * Before the cutover this dispatched by engine (`NEXT_PUBLIC_AUTH_ENGINE`): Better Auth's client vs
 * plain fetches to NextAuth's HTTP endpoints. The NextAuth transport and the flag were removed with the
 * rest of the parallel-run scaffolding in OLO-10.14.
 *
 * `useAuthSession()` also exposes `signIn`/`signOut` helpers so callers never touch a transport
 * directly; `signIn`/`signOut` are also re-exported for the few non-hook call sites.
 */

import React, {
  createContext,
  useCallback,
  useContext,
  useMemo,
} from 'react';
import type { AppSession } from './better-auth-session-shape';
import { setActiveTenant } from './last-active-tenant-actions';
import { authClient } from './auth-client';
import {
  mapBetterAuthSession,
  signInBetterAuth,
  signOutBetterAuth,
  updateUserNameBetterAuth,
} from './better-auth-client-compat';

/** Session status, mirroring NextAuth's `useSession().status`. */
export type AuthStatus = 'loading' | 'authenticated' | 'unauthenticated';

/** Options accepted by {@link useAuthSession}'s `signIn`. */
export interface AuthSignInOptions {
  /** Where to land after a successful sign-in. */
  callbackUrl?: string;
  /** Credentials `payload` JSON blob (`{email,password}` or `{oneTimeCode}`); credentials only. */
  payload?: string;
  /**
   * Accepted for drop-in compatibility with `next-auth/react`'s `signIn`. The compat `signIn` always
   * navigates on completion, so this is ignored — it exists only so existing `{ redirect: true }` call
   * sites keep type-checking.
   */
  redirect?: boolean;
}

/** The `update()` payload — the same NextAuth session-arg shape the call sites already pass. */
export interface AuthUpdatePayload {
  /** Tenant switch (passed top-level by the tenant switcher / onboarding wizard). */
  current_tenant_id?: string;
  /** Display-name change (profile passes it under `user.name`). */
  name?: string;
  user?: { name?: string | null } & Record<string, unknown>;
  [key: string]: unknown;
}

interface AuthSessionContextValue {
  data: AppSession | null;
  status: AuthStatus;
  refetch: () => Promise<void>;
}

const AuthSessionContext = createContext<AuthSessionContextValue | null>(null);

/**
 * Provider for the session — the replacement for NextAuth's `SessionProvider`.
 *
 * Reads the reactive `authClient.useSession()` store and shares it (with an on-demand refetch) through
 * the context {@link useAuthSession} consumes.
 *
 * @param children The app subtree that consumes {@link useAuthSession}.
 */
export function AuthSessionProvider({ children }: { children: React.ReactNode }): React.ReactElement {
  const { data, isPending, refetch } = authClient.useSession();
  const session = useMemo(() => mapBetterAuthSession(data as never), [data]);
  const status: AuthStatus = isPending ? 'loading' : session ? 'authenticated' : 'unauthenticated';
  const value = useMemo<AuthSessionContextValue>(
    () => ({ data: session, status, refetch: async () => void (await refetch()) }),
    [session, status, refetch]
  );
  return <AuthSessionContext.Provider value={value}>{children}</AuthSessionContext.Provider>;
}

/**
 * Sign in, navigating on completion (the `redirect: true` contract).
 *
 * @param provider `'credentials'` or an OAuth provider id.
 * @param options `callbackUrl` and, for credentials, the `payload` blob.
 */
export function signIn(provider: string, options: AuthSignInOptions = {}): Promise<void> {
  return signInBetterAuth(provider, options);
}

/**
 * Sign out and navigate to `callbackUrl`.
 *
 * @param callbackUrl Where to land after sign-out.
 */
export function signOut(callbackUrl: string): Promise<void> {
  return signOutBetterAuth(callbackUrl);
}

/**
 * The replacement for `next-auth/react`'s `useSession()`.
 *
 * @returns `{ data, status, update, signIn, signOut }` — `data`/`status` mirror NextAuth; `update`
 *   persists a tenant switch (validated) or a name change; `signIn`/`signOut` are the sign-in helpers.
 */
export function useAuthSession(): {
  data: AppSession | null;
  status: AuthStatus;
  update: (payload: AuthUpdatePayload) => Promise<void>;
  signIn: typeof signIn;
  signOut: typeof signOut;
} {
  const ctx = useContext(AuthSessionContext);
  if (!ctx) {
    throw new Error('useAuthSession must be used within <AuthSessionProvider>');
  }
  const { data, status, refetch } = ctx;

  const update = useCallback(
    async (payload: AuthUpdatePayload): Promise<void> => {
      // Tenant switch: passed top-level by the switcher / onboarding wizard. Persist through the
      // validated server action; the cookie is the source of truth for the derived tenant.
      const tenantId = typeof payload.current_tenant_id === 'string' ? payload.current_tenant_id : undefined;
      if (tenantId) {
        await setActiveTenant(tenantId);
      }

      // Name change: profile passes it under `user.name` (the session reads `session.user.name`).
      const name =
        (typeof payload.user?.name === 'string' ? payload.user.name : undefined) ??
        (typeof payload.name === 'string' ? payload.name : undefined);
      if (name) {
        await updateUserNameBetterAuth(name);
      }

      await refetch();
    },
    [refetch]
  );

  return { data, status, update, signIn, signOut };
}
