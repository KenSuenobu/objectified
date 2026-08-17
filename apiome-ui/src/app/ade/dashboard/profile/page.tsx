'use client';

/**
 * Profile — `/ade/dashboard/profile` (HIVE-4.7, #5301).
 *
 * Mockup: `docs/mockups/account/profile.html`. Design language: `docs/mockups/DESIGN.md` §5.3
 * (page header + tab row), §7 (one primary action), §8 (detail page = main column + aside).
 *
 * ## What was wrong
 *
 * The page drew its own `<header>` and `<main>` inside the shell's `<main>` — a second landmark
 * nested in the first — and then hand-rolled the rest in named colours: an
 * `indigo → violet → purple` hero band, an `indigo → violet` avatar under a
 * `ring-white dark:ring-gray-800`, five `text-indigo-*` / `text-emerald-*` / `text-cyan-*` /
 * `text-amber-*` card glyphs, and `bg-gray-50/70 dark:bg-gray-900/40` info tiles. None of that
 * could follow a theme. Beneath the skin, its two neighbours were unreachable: Linked accounts
 * only through a card footer, Preferences not at all.
 *
 * ## What it is now
 *
 * `Page` / `PageHeader` / `PageBody` (HIVE-3.5) with the account tab strip — **Profile · Linked
 * accounts · Preferences** — in the header, an identity hero, and a two-column body: Account
 * details and Security on the left, Sign-in methods and Session on the right.
 *
 * Every capability the page had is here, including all six of `TwoFactorSettings`' nested boxes
 * and all five dialogs; `tests/two-factor-settings.test.tsx` passes against that file unchanged.
 *
 * ## What is new, and where it comes from
 *
 * Three additions, each reading data the app already holds rather than a new source:
 *
 * - **Sign-in methods lists the reader's actual methods** — `getUserHasPassword` and
 *   `getLinkedAccountsForUser`, the two calls the Linked accounts page next door already makes.
 * - **The identity hero and the tenant tile name the workspace** — `loadTenantMembershipContext`,
 *   the same server action the rail's workspace switcher loads.
 * - **The session card shows how much of the session is left** — arithmetic on `session.expires`
 *   against Better Auth's own `SESSION_EXPIRES_IN_SECONDS`.
 *
 * Every one of the three fails soft. A REST hiccup in the membership context leaves the workspace
 * unnamed rather than leaving the page blank, because none of them is what the reader came for.
 *
 * ## Why it is still a client component
 *
 * The session is the page's subject and `useAuthSession` is a hook; the name edit has to write
 * back through `update()` so the rail's user menu changes at the same moment; and the copy
 * confirmations, the dialogs and the two-factor flows are all local state.
 */

import { useCallback, useEffect, useState } from 'react';
import { Pencil } from 'lucide-react';

import { useAuthSession } from '@lib/auth/session-client';
import { loadTenantMembershipContext } from '@lib/auth/tenant-membership-context';
import type { TenantMembershipRow } from '@lib/auth/tenant-membership-context-mapping';
import {
  getCurrentUserLastLoginAt,
  getLinkedAccountsForUser,
  getUserHasPassword,
  updateUserName,
  updateUserPassword,
} from '@lib/db/helper';

import { Alert } from '@/app/components/ui/Alert';
import { Button } from '@/app/components/ui/Button';
import { LoadingState } from '@/app/components/ui/LoadingState';
import { Page, PageBody } from '@/app/components/shell/pageChrome';
import PageHeader from '@/app/components/shell/PageHeader';
import {
  AccountDetailsCard,
  AccountTabs,
  ChangePasswordDialog,
  EditNameDialog,
  IdentityHero,
  SecurityCard,
  SessionCard,
  SignInMethodsCard,
  buildSignInMethods,
  type LinkedIdentity,
  type SignInMethodRow,
} from '@/app/components/ade/account';
import { TwoFactorSettings } from './TwoFactorSettings';

/** The `/ade/dashboard` home, which the breadcrumb's first step returns to. */
const HOME_ROUTE = '/ade/dashboard';

/** What the page learns about the reader's account beyond the session itself. */
interface ProfileExtras {
  /** The reader's sign-in methods, password first. */
  methods: SignInMethodRow[];
  /** The current workspace's membership row, when the context resolved one. */
  workspace: TenantMembershipRow | null;
}

/** The empty extras, used before the loads land and whenever one of them fails. */
const NO_EXTRAS: ProfileExtras = { methods: [], workspace: null };

/**
 * Parse a server action's JSON payload without throwing.
 *
 * Both actions below already swallow their own database errors and answer with an empty
 * payload, so the only way this can go wrong is a shape the page does not expect — and a page
 * that threw on it would replace a working profile with a blank screen.
 *
 * @param raw The JSON string the action returned.
 * @param accepts Whether the parsed value is the shape this caller asked for.
 * @param fallback What to use when it does not parse, or is not that shape.
 * @returns The parsed value, or `fallback`.
 */
function parsePayload<T>(raw: string, accepts: (value: unknown) => boolean, fallback: T): T {
  try {
    const parsed: unknown = JSON.parse(raw);
    return accepts(parsed) ? (parsed as T) : fallback;
  } catch {
    return fallback;
  }
}

/**
 * Read a server action's `{ success, error }` envelope.
 *
 * `updateUserName` and `updateUserPassword` both answer with a JSON *string*, and both report
 * failure in the body rather than by throwing.
 *
 * @param raw The JSON string the action returned.
 * @param fallbackError What to say when the action failed without saying why.
 * @returns `null` on success, or the message to show.
 */
function readActionError(raw: string, fallbackError: string): string | null {
  const response = parsePayload<{ success?: boolean; error?: string }>(
    raw,
    (value) => value != null && typeof value === 'object' && !Array.isArray(value),
    {}
  );
  if (response.success) return null;
  return response.error || fallbackError;
}

/**
 * The Profile page.
 *
 * @returns The page's header and body, or the loading state while there is no session.
 */
const Profile = () => {
  const { data: session, update } = useAuthSession();

  const [showEditDialog, setShowEditDialog] = useState(false);
  const [showPasswordDialog, setShowPasswordDialog] = useState(false);
  const [successMessage, setSuccessMessage] = useState('');
  const [lastLoginAt, setLastLoginAt] = useState<string | null | undefined>(undefined);
  const [extras, setExtras] = useState<ProfileExtras>(NO_EXTRAS);
  const [extrasLoading, setExtrasLoading] = useState(true);

  const user = session?.user as
    | {
        user_id?: string;
        current_tenant_id?: string;
        name?: string | null;
        email?: string | null;
        emailVerified?: boolean;
        twoFactorEnabled?: boolean;
      }
    | undefined;
  const userId = user?.user_id;
  const tenantId = user?.current_tenant_id;

  // The last-login lookup is its own effect because it is its own question, asked of the users
  // table rather than of the account's identities, and it re-runs when the session's user does.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const raw = await getCurrentUserLastLoginAt();
        const parsed = parsePayload<{ success?: boolean; lastLoginAt?: string | null }>(
          raw,
          (value) => value != null && typeof value === 'object',
          {}
        );
        if (!cancelled) setLastLoginAt(parsed.success ? (parsed.lastLoginAt ?? null) : null);
      } catch {
        if (!cancelled) setLastLoginAt(null);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [session?.user]);

  // The three lookups behind the added panels share one effect and one `finally`, so the
  // sign-in list and the workspace name appear together rather than one at a time.
  useEffect(() => {
    if (!userId) return;
    let cancelled = false;

    (async () => {
      setExtrasLoading(true);
      try {
        const [accountsRaw, passwordRaw, membership] = await Promise.all([
          getLinkedAccountsForUser(userId),
          getUserHasPassword(userId),
          // Fails soft on its own (it falls back to a name-only listing), but a REST outage can
          // still reject: the workspace stays unnamed rather than taking the page with it.
          loadTenantMembershipContext().catch(() => null),
        ]);
        if (cancelled) return;

        const accounts = parsePayload<LinkedIdentity[]>(accountsRaw, Array.isArray, []);
        const { hasPassword } = parsePayload<{ hasPassword?: boolean }>(
          passwordRaw,
          (value) => value != null && typeof value === 'object',
          {}
        );

        setExtras({
          methods: buildSignInMethods({ hasPassword: Boolean(hasPassword), accounts }),
          workspace: membership?.tenants.find((row) => row.id === tenantId) ?? null,
        });
      } catch {
        if (!cancelled) setExtras(NO_EXTRAS);
      } finally {
        if (!cancelled) setExtrasLoading(false);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [userId, tenantId]);

  const handleSaveName = useCallback(
    async (name: string): Promise<string | null> => {
      // Unreachable from the UI — the dialogs only exist once a session has rendered the page —
      // but the id is what the write is scoped by, so it is checked rather than asserted.
      if (!userId) return 'You are not signed in.';
      try {
        const failure = readActionError(await updateUserName(userId, name), 'Failed to update name');
        if (failure) return failure;
        // The session carries the name the rail's user menu and every activity row print, so it
        // is refreshed here rather than left to the next navigation.
        await update({ ...session, user: { ...session?.user, name } });
        return null;
      } catch (error) {
        return error instanceof Error ? error.message : 'An error occurred';
      }
    },
    [session, update, userId]
  );

  const handleChangePassword = useCallback(
    async (current: string, next: string): Promise<string | null> => {
      if (!userId) return 'You are not signed in.';
      try {
        const failure = readActionError(
          await updateUserPassword(userId, current, next),
          'Failed to update password'
        );
        if (failure) return failure;
        setSuccessMessage('Password changed successfully.');
        return null;
      } catch (error) {
        return error instanceof Error ? error.message : 'An error occurred';
      }
    },
    [userId]
  );

  if (!session) {
    return (
      <Page>
        <PageBody>
          <LoadingState minHeightClassName="min-h-[20rem]" message="Loading profile..." />
        </PageBody>
      </Page>
    );
  }

  const workspaceName = extras.workspace?.name ?? null;
  const workspaceRole = extras.workspace?.role
    ? extras.workspace.role.charAt(0).toUpperCase() + extras.workspace.role.slice(1)
    : null;

  return (
    <Page>
      <PageHeader
        breadcrumb={[
          { label: workspaceName ?? 'Home', href: HOME_ROUTE },
          { label: 'Account' },
          { label: 'Profile' },
        ]}
        title="Profile"
        description="Your identity, password, two-factor and sign-in methods."
        actions={
          <Button
            variant="outline"
            onClick={() => setShowEditDialog(true)}
            data-testid="profile-edit-name-header"
          >
            <Pencil aria-hidden />
            Edit name
          </Button>
        }
        tabs={
          <AccountTabs
            current="profile"
            linkedCount={
              extrasLoading
                ? undefined
                : extras.methods.filter((method) => !method.isPassword).length
            }
          />
        }
      />

      <PageBody>
        {successMessage && (
          <Alert variant="ok" onClose={() => setSuccessMessage('')} data-testid="profile-success">
            {successMessage}
          </Alert>
        )}

        <IdentityHero
          name={user?.name}
          email={user?.email}
          seed={userId}
          workspaceName={workspaceName}
          workspaceRole={workspaceRole}
          hasWorkspace={Boolean(tenantId)}
          twoFactorEnabled={Boolean(user?.twoFactorEnabled)}
        />

        <div className="acct-grid">
          <div className="acct-grid__main">
            <AccountDetailsCard
              name={user?.name}
              email={user?.email}
              emailVerified={user?.emailVerified}
              userId={userId}
              tenantId={tenantId}
              workspaceName={workspaceName}
              lastLoginAt={lastLoginAt}
              onEditName={() => setShowEditDialog(true)}
            />

            <SecurityCard
              twoFactor={<TwoFactorSettings />}
              onChangePassword={() => setShowPasswordDialog(true)}
            />
          </div>

          <aside className="acct-grid__aside" aria-label="Sign-in methods and session">
            <SignInMethodsCard methods={extras.methods} loading={extrasLoading} />
            <SessionCard expires={session.expires} />
          </aside>
        </div>

        <EditNameDialog
          open={showEditDialog}
          onOpenChange={setShowEditDialog}
          initialName={user?.name ?? ''}
          onSubmit={handleSaveName}
        />

        <ChangePasswordDialog
          open={showPasswordDialog}
          onOpenChange={setShowPasswordDialog}
          onSubmit={handleChangePassword}
        />
      </PageBody>
    </Page>
  );
};

export default Profile;
