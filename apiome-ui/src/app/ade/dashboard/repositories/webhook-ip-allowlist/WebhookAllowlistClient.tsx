'use client';

/**
 * Bring in → Webhook IP allowlist (HIVE-7.6, #5323).
 *
 * Authority: `docs/mockups/sources/webhook-allowlist.html`, whose **Notes → Keeps (1:1)** list
 * is this ticket's acceptance criteria for this screen; DESIGN.md §7 (cards, dialogs) and §8
 * (destructive confirms).
 *
 * ### What this screen is
 *
 * The webhook endpoint is the one repository route with no bearer token: the HMAC signature
 * over the raw body is its authentication. That is sound, and it is reached by anyone who can
 * open a socket. The allowlist puts a network filter in front of it, and this screen is where
 * an operator can see — and change — what that filter allows.
 *
 * Three things drove the original design and still do:
 *
 *  * **The posture is stated, not inferred.** Three independent switches decide whether the
 *    filter is doing anything, and "enforced" next to an empty range table is the state most
 *    likely to be misread as safety.
 *  * **Staleness is as important as content.** Each provider carries its own refresh verdict,
 *    and `skipped` is drawn as a settled state rather than a fault.
 *  * **A bypass has to be deliberate.** The reason is what the audit ledger records.
 *
 * ### What the redesign changed
 *
 * 1. **Two edits happened the moment they were clicked.** Removing a range and bypassing
 *    enforcement both weaken the filter in front of an unauthenticated endpoint, and both were
 *    one click. Both go through a confirm now, which is the ticket's third acceptance
 *    criterion. Enabling a range and restoring enforcement stay one click, because neither
 *    widens what is accepted.
 * 2. **The bypass reason was checked by a toast.** A missing reason raised an error toast and
 *    left the field unmarked; it is a field error on the field now, and the confirm cannot
 *    open without one.
 * 3. **Four inputs were hand-rolled** with `border-gray-300 bg-white dark:border-gray-600` and
 *    a `<label>` above each. They are `ui/FormField` + `ui/Input`.
 * 4. **A failed read was a rose panel** with no way out. It is `ui/ErrorState` with a retry.
 * 5. **The header carried a back link.** It is the shared page header with the Repositories
 *    sub-nav under it.
 *
 * Non-administrators still see everything and can change nothing: seeing the filter is how
 * anyone diagnoses "our webhooks stopped", while widening it is an administrator's act. The
 * server decides that, and a refusal arrives as the toast this screen already shows.
 */

import * as React from 'react';
import { RefreshCw } from 'lucide-react';
import { toast } from 'sonner';

import { useAuthSession } from '@lib/auth/session-client';

import PageHeader from '@/app/components/shell/PageHeader';
import { Page, PageBody } from '@/app/components/shell/pageChrome';
import { Button } from '@/app/components/ui/Button';
import { GatedState } from '@/app/components/ui/EmptyState';
import { ErrorState } from '@/app/components/ui/ErrorState';
import { LoadingState } from '@/app/components/ui/LoadingState';
import {
  ALLOWLIST_ERROR_FALLBACK,
  ALLOWLIST_ERROR_TITLE,
  ALLOWLIST_LOADING,
  ALLOWLIST_NO_TENANT,
  ALLOWLIST_PAGE_DESC,
  ALLOWLIST_SAVE_ERROR,
  ALLOWLIST_TOASTS,
  AllowlistEnforcementCard,
  AllowlistPostureBanner,
  AllowlistProviderCard,
  AllowlistRangesCard,
  RepositoriesSubNav,
  allowlistPosture,
  type IpAllowlistEntry,
  type IpAllowlistResponse,
} from '@/app/components/ade/repositories';

/** The API base for this screen; the entry routes hang below it. */
const API = '/api/repositories/webhook-ip-allowlist';

/** Where the breadcrumb's first crumb goes. */
const HOME_ROUTE = '/ade/dashboard';

/**
 * The allowlist screen.
 *
 * @returns The page.
 */
export function WebhookAllowlistClient() {
  const { data: session } = useAuthSession();
  const currentTenantId = (session?.user as { current_tenant_id?: string } | undefined)
    ?.current_tenant_id;

  const [data, setData] = React.useState<IpAllowlistResponse | null>(null);
  const [loading, setLoading] = React.useState(true);
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  const load = React.useCallback(async () => {
    if (!currentTenantId) {
      setData(null);
      setLoading(false);
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const response = await fetch(API, { credentials: 'include' });
      const payload = (await response.json().catch(() => ({}))) as IpAllowlistResponse;
      if (!response.ok) {
        throw new Error(
          typeof payload.error === 'string' ? payload.error : response.statusText
        );
      }
      setData(payload);
    } catch (caught) {
      const message = caught instanceof Error ? caught.message : ALLOWLIST_ERROR_FALLBACK;
      setData(null);
      setError(message);
      toast.error(message);
    } finally {
      setLoading(false);
    }
  }, [currentTenantId]);

  React.useEffect(() => {
    void load();
  }, [load]);

  /**
   * Run one mutation and adopt the allowlist it answers with.
   *
   * Every mutation returns the whole allowlist, so the screen re-renders from what was
   * actually stored rather than from what it hoped it stored — an edit can never leave the
   * page disagreeing with the database.
   *
   * @param path The route below {@link API}.
   * @param init The request.
   * @param successMessage The toast a stored change raises.
   * @returns True when the server accepted the change.
   */
  const mutate = React.useCallback(
    async (path: string, init: RequestInit, successMessage: string): Promise<boolean> => {
      setBusy(true);
      try {
        const response = await fetch(`${API}${path}`, {
          credentials: 'include',
          headers: { 'Content-Type': 'application/json' },
          ...init,
        });
        const payload = (await response.json().catch(() => ({}))) as IpAllowlistResponse;
        if (!response.ok) {
          throw new Error(
            typeof payload.error === 'string' ? payload.error : response.statusText
          );
        }
        setData(payload);
        toast.success(successMessage);
        return true;
      } catch (caught) {
        toast.error(caught instanceof Error ? caught.message : ALLOWLIST_SAVE_ERROR);
        return false;
      } finally {
        setBusy(false);
      }
    },
    []
  );

  const addEntry = React.useCallback(
    (cidr: string, description: string) =>
      mutate(
        '',
        { method: 'POST', body: JSON.stringify({ cidr, description }) },
        ALLOWLIST_TOASTS.added
      ),
    [mutate]
  );

  const toggleEntry = React.useCallback(
    (entry: IpAllowlistEntry) => {
      void mutate(
        `/entries/${entry.id}`,
        { method: 'PATCH', body: JSON.stringify({ enabled: !entry.enabled }) },
        entry.enabled ? ALLOWLIST_TOASTS.disabled : ALLOWLIST_TOASTS.enabled
      );
    },
    [mutate]
  );

  const removeEntry = React.useCallback(
    (entry: IpAllowlistEntry) => {
      void mutate(`/entries/${entry.id}`, { method: 'DELETE' }, ALLOWLIST_TOASTS.removed);
    },
    [mutate]
  );

  const setPolicy = React.useCallback(
    (enforcementEnabled: boolean, reason: string) => {
      void mutate(
        '',
        {
          method: 'PUT',
          body: JSON.stringify({
            enforcementEnabled,
            bypassReason: enforcementEnabled ? null : reason,
          }),
        },
        enforcementEnabled ? ALLOWLIST_TOASTS.restored : ALLOWLIST_TOASTS.bypassed
      );
    },
    [mutate]
  );

  const posture = data ? allowlistPosture(data) : null;

  return (
    <Page>
      <PageHeader
        breadcrumb={[
          { label: 'Home', href: HOME_ROUTE },
          { label: 'Bring in' },
          { label: 'Repositories', href: '/ade/dashboard/repositories' },
          { label: 'Webhook IP allowlist' },
        ]}
        title="Webhook IP allowlist"
        description={ALLOWLIST_PAGE_DESC}
        actions={
          <Button
            variant="outline"
            onClick={() => void load()}
            disabled={loading || busy || !currentTenantId}
            data-testid="allowlist-refresh"
          >
            <RefreshCw className={loading ? 'animate-spin' : undefined} aria-hidden />
            Refresh
          </Button>
        }
        tabs={<RepositoriesSubNav active="allowlist" />}
      />

      <PageBody>
        {!currentTenantId ? (
          <GatedState description={ALLOWLIST_NO_TENANT} />
        ) : error ? (
          <ErrorState
            title={ALLOWLIST_ERROR_TITLE}
            description={error}
            onRetry={() => void load()}
            data-testid="allowlist-error"
          />
        ) : loading && !data ? (
          <LoadingState message={ALLOWLIST_LOADING} />
        ) : data && posture ? (
          <>
            <AllowlistPostureBanner posture={posture} data={data} />

            <div className="wal-providers" data-testid="allowlist-providers">
              {data.providers.map((provider) => (
                <AllowlistProviderCard key={provider.provider} provider={provider} />
              ))}
            </div>

            <AllowlistRangesCard
              entries={data.entries}
              busy={busy}
              onAdd={addEntry}
              onToggle={toggleEntry}
              onRemove={removeEntry}
            />

            <AllowlistEnforcementCard
              enforcing={data.tenantEnforcementEnabled}
              policyUpdatedAt={data.policyUpdatedAt}
              busy={busy}
              onSetPolicy={setPolicy}
            />
          </>
        ) : null}
      </PageBody>
    </Page>
  );
}

export default WebhookAllowlistClient;
