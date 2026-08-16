'use client';

/**
 * Webhook source-IP allowlist panel (REPO-7.6, #2804).
 *
 * The webhook endpoint is the one repository route with no bearer token: the HMAC signature
 * over the raw body is its authentication. That is sound, and it is reached by anyone who can
 * open a socket. The allowlist puts a network filter in front of it, and this screen is where
 * an operator can see — and change — what that filter allows.
 *
 * Three things drive the design:
 *
 *  * **The posture is stated, not inferred.** Three independent switches decide whether the
 *    filter is doing anything (the deployment setting, this workspace's policy, and whether
 *    any ranges are cached to filter against). The banner combines them into one sentence,
 *    because "enforced" next to an empty range table is the state most likely to be misread
 *    as safety.
 *  * **Staleness is as important as content.** A cached range list that stopped refreshing
 *    two weeks ago is a filter that will reject legitimate deliveries the moment the provider
 *    moves. Each provider carries its own refresh verdict, and `skipped` is drawn as a
 *    settled state rather than a fault — GitLab publishing no list is a choice, not a failure.
 *  * **A bypass has to be deliberate.** Turning enforcement off asks for a reason before the
 *    button does anything, and the reason is what the audit ledger records. A control that
 *    can be turned off in one click is one that gets turned off and forgotten.
 *
 * Non-administrators see everything and can change nothing: seeing the filter is how anyone
 * diagnoses "our webhooks stopped", while widening it is an administrator's act.
 */

import Link from 'next/link';
import { useCallback, useEffect, useState } from 'react';
import { AlertTriangle, ArrowLeft, Globe, Plus, RefreshCw, ShieldCheck, Trash2 } from 'lucide-react';
import { toast } from 'sonner';
import { useAuthSession } from '@lib/auth/session-client';
import { cn } from '@lib/utils';
import { Button } from '@/app/components/ui/Button';
import { GatedState } from '@/app/components/ui/EmptyState';
import { LoadingState } from '@/app/components/ui/LoadingState';
import {
  dashboardContentStackClass,
  dashboardMainClass,
  dashboardPanelPaddedClass,
} from '@/app/components/ade/dashboard/dashboardScreenClasses';
import {
  POSTURE_COPY,
  POSTURE_TONE,
  type AllowlistPosture,
  type IpAllowlistEntry,
  type IpAllowlistResponse,
  type IpProvider,
  allowlistPosture,
  cadenceLabel,
  formatTimestamp,
  providerLabel,
  refreshSummary,
  validateCidr,
} from '@/app/components/ade/dashboard/repositories/repositoryWebhookIpAllowlist';

/** Panel accent per posture tone, so the state reads before the text does. */
const TONE_PANEL_CLASSES: Record<'neutral' | 'warn' | 'good', string> = {
  neutral: 'border-gray-200 dark:border-gray-700',
  warn: 'border-amber-300 bg-amber-50 dark:border-amber-700 dark:bg-amber-900/20',
  good: 'border-emerald-200 dark:border-emerald-800',
};

/** The API base for this screen; the entry routes hang below it. */
const API = '/api/repositories/webhook-ip-allowlist';

/** The banner: what the filter is actually doing right now, in one sentence. */
function PostureBanner({ posture, data }: { posture: AllowlistPosture; data: IpAllowlistResponse }) {
  const copy = POSTURE_COPY[posture];
  return (
    <section
      className={cn(dashboardPanelPaddedClass, TONE_PANEL_CLASSES[POSTURE_TONE[posture]])}
      aria-label="Allowlist status"
      data-testid="allowlist-posture"
      data-posture={posture}
    >
      <h2 className="flex items-center gap-2 text-sm font-semibold text-gray-900 dark:text-gray-100">
        {POSTURE_TONE[posture] === 'good' ? (
          <ShieldCheck className="h-4 w-4 shrink-0 text-emerald-500" aria-hidden />
        ) : (
          <AlertTriangle className="h-4 w-4 shrink-0 text-amber-500" aria-hidden />
        )}
        {copy.title}
      </h2>
      <p className="mt-1 max-w-3xl text-sm text-gray-600 dark:text-gray-300">{copy.body}</p>
      {data.bypassReason ? (
        <p className="mt-2 text-xs text-gray-500 dark:text-gray-400" data-testid="bypass-reason">
          Bypass reason: {data.bypassReason}
        </p>
      ) : null}
      <dl className="mt-4 grid grid-cols-2 gap-4 text-xs sm:grid-cols-3">
        <div>
          <dt className="uppercase tracking-wider text-gray-500 dark:text-gray-400">
            Provider ranges refresh
          </dt>
          <dd className="mt-0.5 text-gray-800 dark:text-gray-200">
            {cadenceLabel(data.refreshIntervalSeconds)}
          </dd>
        </div>
        <div>
          <dt className="uppercase tracking-wider text-gray-500 dark:text-gray-400">
            Empty range cache
          </dt>
          <dd className="mt-0.5 text-gray-800 dark:text-gray-200">
            {data.strict ? 'Blocks deliveries' : 'Allows, with a warning'}
          </dd>
        </div>
        <div>
          <dt className="uppercase tracking-wider text-gray-500 dark:text-gray-400">
            Trusted proxies
          </dt>
          <dd className="mt-0.5 text-gray-800 dark:text-gray-200">
            {data.trustedProxyHops === 0
              ? 'None — the socket peer is the source'
              : `${data.trustedProxyHops} hop(s) of X-Forwarded-For`}
          </dd>
        </div>
      </dl>
    </section>
  );
}

/** One provider's cached ranges, with the health of the refresh that fills them. */
function ProviderCard({ provider }: { provider: IpProvider }) {
  return (
    <section
      className={cn(
        dashboardPanelPaddedClass,
        provider.stale && provider.lastOutcome !== 'skipped'
          ? 'border-amber-200 dark:border-amber-800'
          : undefined
      )}
      aria-label={`${providerLabel(provider.provider)} ranges`}
      data-testid="provider-card"
      data-provider={provider.provider}
      data-stale={provider.stale ? 'true' : 'false'}
    >
      <div className="flex flex-wrap items-start justify-between gap-2">
        <h3 className="flex items-center gap-1.5 text-sm font-semibold text-gray-900 dark:text-gray-100">
          <Globe className="h-4 w-4 shrink-0 text-indigo-500" aria-hidden />
          {providerLabel(provider.provider)}
        </h3>
        <span className="font-mono text-xs text-gray-500 dark:text-gray-400">
          {provider.rangeCount} range{provider.rangeCount === 1 ? '' : 's'}
        </span>
      </div>

      <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">{provider.note}</p>
      <p className="mt-1 text-xs text-gray-600 dark:text-gray-300" data-testid="refresh-summary">
        {refreshSummary(provider)}
      </p>
      {provider.lastError && provider.lastOutcome !== 'skipped' ? (
        <p className="mt-1 text-xs text-amber-700 dark:text-amber-300" role="status">
          {provider.lastError}
        </p>
      ) : null}

      {provider.ranges.length > 0 ? (
        <ul className="mt-3 flex max-h-40 flex-wrap gap-1.5 overflow-y-auto">
          {provider.ranges.map((range) => (
            <li
              key={range.cidr}
              className="rounded border border-gray-200 px-1.5 py-0.5 font-mono text-2xs text-gray-700 dark:border-gray-700 dark:text-gray-300"
              title={
                range.source === 'configured'
                  ? 'Supplied by this deployment’s settings'
                  : 'Published by the provider'
              }
            >
              {range.cidr}
            </li>
          ))}
        </ul>
      ) : (
        <p className="mt-3 text-xs italic text-gray-500 dark:text-gray-400">
          No ranges cached.
        </p>
      )}
    </section>
  );
}

/** One tenant-managed entry, with its controls. */
function EntryRow({
  entry,
  busy,
  onToggle,
  onRemove,
}: {
  entry: IpAllowlistEntry;
  busy: boolean;
  onToggle: (entry: IpAllowlistEntry) => void;
  onRemove: (entry: IpAllowlistEntry) => void;
}) {
  return (
    <li
      className="flex flex-wrap items-center justify-between gap-3 border-b border-gray-100 py-2 last:border-b-0 dark:border-gray-800"
      data-testid="allowlist-entry"
      data-cidr={entry.cidr}
      data-enabled={entry.enabled ? 'true' : 'false'}
    >
      <div className="min-w-0">
        <p className="font-mono text-sm text-gray-900 dark:text-gray-100">{entry.cidr}</p>
        <p className="text-xs text-gray-500 dark:text-gray-400">
          {entry.description || 'No description'} · added {formatTimestamp(entry.createdAt)}
        </p>
      </div>
      <div className="flex shrink-0 items-center gap-2">
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={busy}
          onClick={() => onToggle(entry)}
        >
          {entry.enabled ? 'Disable' : 'Enable'}
        </Button>
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={busy}
          aria-label={`Remove ${entry.cidr}`}
          onClick={() => onRemove(entry)}
        >
          <Trash2 className="h-3.5 w-3.5" aria-hidden />
        </Button>
      </div>
    </li>
  );
}

/**
 * The allowlist screen: what the filter allows, and the two ways to change it.
 */
export function RepositoryWebhookIpAllowlist() {
  const { data: session } = useAuthSession();
  const currentTenantId = (session?.user as { current_tenant_id?: string })?.current_tenant_id;

  const [data, setData] = useState<IpAllowlistResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [cidr, setCidr] = useState('');
  const [description, setDescription] = useState('');
  const [cidrError, setCidrError] = useState<string | null>(null);
  const [bypassReason, setBypassReason] = useState('');

  const load = useCallback(async () => {
    if (!currentTenantId) {
      setData(null);
      setLoading(false);
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(API, { credentials: 'include' });
      const payload = (await res.json().catch(() => ({}))) as IpAllowlistResponse;
      if (!res.ok) {
        throw new Error(typeof payload.error === 'string' ? payload.error : res.statusText);
      }
      setData(payload);
    } catch (e) {
      const message = e instanceof Error ? e.message : 'Could not load the allowlist.';
      setData(null);
      setError(message);
      toast.error(message);
    } finally {
      setLoading(false);
    }
  }, [currentTenantId]);

  useEffect(() => {
    void load();
  }, [load]);

  /**
   * Run one mutation and adopt the allowlist it answers with.
   *
   * Every mutation returns the whole allowlist, so the screen re-renders from what was
   * actually stored rather than from what it hoped it stored — an edit can never leave the
   * page disagreeing with the database.
   */
  const mutate = useCallback(
    async (path: string, init: RequestInit, successMessage: string) => {
      setBusy(true);
      try {
        const res = await fetch(`${API}${path}`, {
          credentials: 'include',
          headers: { 'Content-Type': 'application/json' },
          ...init,
        });
        const payload = (await res.json().catch(() => ({}))) as IpAllowlistResponse;
        if (!res.ok) {
          throw new Error(typeof payload.error === 'string' ? payload.error : res.statusText);
        }
        setData(payload);
        toast.success(successMessage);
        return true;
      } catch (e) {
        toast.error(e instanceof Error ? e.message : 'That change could not be saved.');
        return false;
      } finally {
        setBusy(false);
      }
    },
    []
  );

  const addEntry = useCallback(async () => {
    const invalid = validateCidr(cidr);
    setCidrError(invalid);
    if (invalid) return;
    if (!description.trim()) {
      setCidrError('Say why this range should be allowed.');
      return;
    }
    const ok = await mutate(
      '',
      { method: 'POST', body: JSON.stringify({ cidr: cidr.trim(), description: description.trim() }) },
      'Range allowed.'
    );
    if (ok) {
      setCidr('');
      setDescription('');
    }
  }, [cidr, description, mutate]);

  const toggleEntry = useCallback(
    (entry: IpAllowlistEntry) =>
      mutate(
        `/entries/${entry.id}`,
        { method: 'PATCH', body: JSON.stringify({ enabled: !entry.enabled }) },
        entry.enabled ? 'Range disabled.' : 'Range enabled.'
      ),
    [mutate]
  );

  const removeEntry = useCallback(
    (entry: IpAllowlistEntry) =>
      mutate(`/entries/${entry.id}`, { method: 'DELETE' }, 'Range removed.'),
    [mutate]
  );

  const setPolicy = useCallback(
    async (enforcementEnabled: boolean) => {
      if (!enforcementEnabled && !bypassReason.trim()) {
        toast.error('Say why enforcement is being turned off — the audit trail records it.');
        return;
      }
      const ok = await mutate(
        '',
        {
          method: 'PUT',
          body: JSON.stringify({
            enforcementEnabled,
            bypassReason: enforcementEnabled ? null : bypassReason.trim(),
          }),
        },
        enforcementEnabled ? 'Enforcement restored.' : 'Enforcement bypassed for this workspace.'
      );
      if (ok) setBypassReason('');
    },
    [bypassReason, mutate]
  );

  if (!currentTenantId) {
    return (
      <main className={dashboardMainClass}>
        <GatedState description="The webhook allowlist is scoped to one workspace." />
      </main>
    );
  }

  const posture = data ? allowlistPosture(data) : null;

  return (
    <main className={dashboardMainClass} aria-busy={loading}>
      <div className={dashboardContentStackClass}>
        <header className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <Link
              href="/ade/dashboard/repositories"
              className="inline-flex items-center gap-1 text-xs text-gray-500 hover:text-indigo-600 dark:text-gray-400 dark:hover:text-indigo-400"
            >
              <ArrowLeft className="h-3.5 w-3.5 shrink-0" aria-hidden />
              Repositories
            </Link>
            <h1 className="mt-1 flex items-center gap-2 text-xl font-semibold text-gray-900 dark:text-gray-100">
              <ShieldCheck className="h-5 w-5 shrink-0 text-indigo-500" aria-hidden />
              Webhook IP allowlist
            </h1>
            <p className="mt-1 max-w-3xl text-sm text-gray-500 dark:text-gray-400">
              Which source addresses may deliver webhooks here. Deliveries from anywhere else are
              refused before their signature is checked.
            </p>
          </div>
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => void load()}
            disabled={loading || busy}
          >
            <RefreshCw className={cn('mr-2 h-3.5 w-3.5', loading && 'animate-spin')} aria-hidden />
            Refresh
          </Button>
        </header>

        {loading && !data ? (
          <LoadingState className="min-h-[30vh]" message="Loading the allowlist…" />
        ) : null}

        {error ? (
          <div
            className={cn(
              dashboardPanelPaddedClass,
              'border-red-200 bg-red-50 dark:border-red-800 dark:bg-red-900/20'
            )}
            role="alert"
          >
            <h2 className="text-sm font-semibold text-red-900 dark:text-red-200">
              Allowlist unavailable
            </h2>
            <p className="mt-1 text-sm text-red-800 dark:text-red-300">{error}</p>
          </div>
        ) : null}

        {data && posture ? (
          <>
            <PostureBanner posture={posture} data={data} />

            <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3">
              {data.providers.map((provider) => (
                <ProviderCard key={provider.provider} provider={provider} />
              ))}
            </div>

            <section className={dashboardPanelPaddedClass} aria-label="Additional ranges">
              <h2 className="text-sm font-semibold text-gray-900 dark:text-gray-100">
                Additional ranges for this workspace
              </h2>
              <p className="mt-1 max-w-3xl text-xs text-gray-500 dark:text-gray-400">
                For the addresses no provider publishes — a self-hosted runner, an egress
                gateway, a relay. These apply to this workspace’s repositories only.
              </p>

              <div className="mt-4 flex flex-wrap items-start gap-2">
                <div className="min-w-[12rem] flex-1">
                  <label
                    htmlFor="allowlist-cidr"
                    className="block text-2xs uppercase tracking-wider text-gray-500 dark:text-gray-400"
                  >
                    Address or CIDR
                  </label>
                  <input
                    id="allowlist-cidr"
                    type="text"
                    value={cidr}
                    onChange={(e) => {
                      setCidr(e.target.value);
                      if (cidrError) setCidrError(null);
                    }}
                    placeholder="203.0.113.0/24"
                    aria-invalid={cidrError ? 'true' : undefined}
                    aria-describedby={cidrError ? 'allowlist-cidr-error' : undefined}
                    className="mt-1 w-full rounded-md border border-gray-300 bg-white px-2 py-1.5 font-mono text-sm text-gray-900 dark:border-gray-600 dark:bg-gray-800 dark:text-gray-100"
                  />
                </div>
                <div className="min-w-[14rem] flex-1">
                  <label
                    htmlFor="allowlist-description"
                    className="block text-2xs uppercase tracking-wider text-gray-500 dark:text-gray-400"
                  >
                    Why
                  </label>
                  <input
                    id="allowlist-description"
                    type="text"
                    value={description}
                    onChange={(e) => setDescription(e.target.value)}
                    placeholder="Self-hosted GitLab runner"
                    className="mt-1 w-full rounded-md border border-gray-300 bg-white px-2 py-1.5 text-sm text-gray-900 dark:border-gray-600 dark:bg-gray-800 dark:text-gray-100"
                  />
                </div>
                <Button
                  type="button"
                  size="sm"
                  className="mt-5 shrink-0"
                  disabled={busy}
                  onClick={() => void addEntry()}
                >
                  <Plus className="mr-1 h-3.5 w-3.5" aria-hidden />
                  Allow range
                </Button>
              </div>
              {cidrError ? (
                <p
                  id="allowlist-cidr-error"
                  role="alert"
                  className="mt-2 text-xs text-red-600 dark:text-red-400"
                >
                  {cidrError}
                </p>
              ) : null}

              {data.entries.length > 0 ? (
                <ul className="mt-4">
                  {data.entries.map((entry) => (
                    <EntryRow
                      key={entry.id}
                      entry={entry}
                      busy={busy}
                      onToggle={(e) => void toggleEntry(e)}
                      onRemove={(e) => void removeEntry(e)}
                    />
                  ))}
                </ul>
              ) : (
                <p className="mt-4 text-xs italic text-gray-500 dark:text-gray-400">
                  No additional ranges. Only the provider-published ranges above are allowed.
                </p>
              )}
            </section>

            <section className={dashboardPanelPaddedClass} aria-label="Enforcement">
              <h2 className="text-sm font-semibold text-gray-900 dark:text-gray-100">
                Enforcement for this workspace
              </h2>
              <p className="mt-1 max-w-3xl text-xs text-gray-500 dark:text-gray-400">
                Bypassing the allowlist means this workspace’s repositories accept deliveries from
                any address. Tenant administrators only, and the reason is recorded in the audit
                ledger.
              </p>
              {data.tenantEnforcementEnabled ? (
                <div className="mt-4 flex flex-wrap items-end gap-2">
                  <div className="min-w-[16rem] flex-1">
                    <label
                      htmlFor="allowlist-bypass-reason"
                      className="block text-2xs uppercase tracking-wider text-gray-500 dark:text-gray-400"
                    >
                      Reason for bypassing
                    </label>
                    <input
                      id="allowlist-bypass-reason"
                      type="text"
                      value={bypassReason}
                      onChange={(e) => setBypassReason(e.target.value)}
                      placeholder="Vendor relay delivers from an unpublished address"
                      className="mt-1 w-full rounded-md border border-gray-300 bg-white px-2 py-1.5 text-sm text-gray-900 dark:border-gray-600 dark:bg-gray-800 dark:text-gray-100"
                    />
                  </div>
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    disabled={busy}
                    onClick={() => void setPolicy(false)}
                  >
                    Bypass allowlist
                  </Button>
                </div>
              ) : (
                <Button
                  type="button"
                  size="sm"
                  className="mt-4"
                  disabled={busy}
                  onClick={() => void setPolicy(true)}
                >
                  Restore enforcement
                </Button>
              )}
              {data.policyUpdatedAt ? (
                <p className="mt-2 text-2xs text-gray-500 dark:text-gray-400">
                  Last changed {formatTimestamp(data.policyUpdatedAt)}.
                </p>
              ) : null}
            </section>
          </>
        ) : null}
      </div>
    </main>
  );
}
