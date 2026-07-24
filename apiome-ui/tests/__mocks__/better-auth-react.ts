/**
 * Jest stub for `better-auth/react` (OLO-10.12).
 *
 * `better-auth` ships ESM-only, which ts-jest's CommonJS transform cannot `require`. Component tests
 * now transitively import `lib/auth/auth-client.ts` (via the session compat layer), so this lightweight
 * stub lets those tests load without pulling the real ESM package. The returned client exposes only the
 * surface the compat layer touches; tests that exercise Better Auth behavior mock it directly.
 */

export function createAuthClient(): unknown {
  return {
    useSession: () => ({
      data: null,
      isPending: false,
      isRefetching: false,
      error: null,
      refetch: async () => {},
    }),
    signIn: {
      email: async () => ({ data: null, error: null }),
      oauth2: async () => ({ data: null, error: null }),
      social: async () => ({ data: null, error: null }),
    },
    signOut: async () => ({ data: null, error: null }),
    updateUser: async () => ({ data: null, error: null }),
    twoFactor: {
      enable: async () => ({ data: null, error: null }),
      disable: async () => ({ data: null, error: null }),
      verifyTotp: async () => ({ data: null, error: null }),
      getTotpUri: async () => ({ data: null, error: null }),
    },
  };
}
