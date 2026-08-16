'use client';

/**
 * Linked-accounts panel (client half).
 *
 * Provider availability comes from the provider registry (OLO-2.3, #4195): the server page
 * resolves `ProviderSummary` objects from env and passes them here, so this panel offers
 * exactly the providers the deployment enables. `coming-soon` registry entries render as
 * teaser cards; an `available` provider whose env is not configured is hidden entirely
 * (its NextAuth route is not registered, so linking it could only dead-end). Rows for
 * already-linked accounts always render, even if their provider was since disabled.
 */
import { useAuthSession, signIn } from '@lib/auth/session-client';
import { useEffect, useState } from 'react';
import { Plus, Trash2, Link as LinkIcon, Key } from 'lucide-react';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
  DialogDescription,
} from '../../../components/ui/Dialog';
import { Button } from '../../../components/ui/Button';
import { Input } from '../../../components/ui/Input';
import { Label } from '../../../components/ui/Label';
import { Alert } from '../../../components/ui/Alert';
import { LoadingState } from '../../../components/ui/LoadingState';
import { EmptyState } from '../../../components/ui/EmptyState';
import { Card, CardContent } from '../../../components/ui/Card';
import { Badge } from '../../../components/ui/Badge';
import { cn } from '../../../../../lib/utils';
import type { ProviderSummary } from '../../../../../lib/auth/provider-registry';
import { getProviderBrand } from '../../../components/auth/provider-brand';
import { useDialog } from '@/app/components/providers/DialogProvider';
import { getLinkedAccountsForUser, getUserHasPassword, unlinkExternalAccount, updatePersonalAccessToken, removePersonalAccessToken } from '../../../../../lib/db/helper';
import {
  dashboardContentStackClass,
  dashboardMainClass,
  dashboardPanelClass,
  dashboardTableWrapClass,
  dashboardTableTheadClass,
  dashboardThClass,
  dashboardThRightClass,
  dashboardTbodyClass,
  dashboardTrHoverClass,
} from '@/app/components/ade/dashboard/dashboardScreenClasses';
import { ICON_SIZE } from '@/app/components/ui/iconSizes';

interface LinkedAccount {
  id: string;
  provider: string;
  provider_user_id: string;
  provider_email: string;
  provider_username: string | null;
  /** Last 6 characters of PAT when set (for display only; full token never sent to client) */
  access_token_suffix?: string | null;
  created_at: string;
  last_login_at: string | null;
}

/** Providers whose linked accounts support a Personal Access Token for direct repo access. */
const PAT_PROVIDERS: ReadonlySet<string> = new Set(['github', 'gitlab']);

interface LinkedAccountsClientProps {
  /** Registry summaries for every known provider (enabled or not), resolved server-side. */
  providers: ProviderSummary[];
}

const LinkedAccountsClient = ({ providers }: LinkedAccountsClientProps) => {
  const { data: session } = useAuthSession();
  const { confirm: confirmDialog } = useDialog();
  const [linkedAccounts, setLinkedAccounts] = useState<LinkedAccount[]>([]);
  /** Whether the user has a usable password sign-in method (OLO-2.4 last-method guard). */
  const [hasPassword, setHasPassword] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const [errorMessage, setErrorMessage] = useState('');
  const [successMessage, setSuccessMessage] = useState('');
  const [patDialogOpen, setPatDialogOpen] = useState(false);
  const [patProvider, setPatProvider] = useState<string>('');
  const [patToken, setPatToken] = useState('');
  const [editingAccountId, setEditingAccountId] = useState<string | null>(null);

  const userId = (session?.user as any)?.user_id;

  /** The "Add a provider" cards: enabled providers plus coming-soon teasers. */
  const providerCards = providers.filter(
    (provider) => provider.enabled || provider.status === 'coming-soon'
  );

  /** Display label for a provider id, falling back to a capitalized slug for unknown ids. */
  const getProviderDisplayName = (providerId: string) =>
    providers.find((provider) => provider.id === providerId)?.label ||
    providerId.charAt(0).toUpperCase() + providerId.slice(1);

  useEffect(() => {
    if (userId) {
      loadLinkedAccounts();
      const urlParams = new URLSearchParams(window.location.search);
      if (urlParams.get('linked') === 'true') {
        setSuccessMessage('Account linked successfully!');
        window.history.replaceState({}, '', '/ade/dashboard/linked-accounts');
      } else if (urlParams.get('error')) {
        setErrorMessage(urlParams.get('error') || 'Failed to link account');
        window.history.replaceState({}, '', '/ade/dashboard/linked-accounts');
      }
    }
  }, [userId]);

  const loadLinkedAccounts = async () => {
    if (!userId) return;
    setIsLoading(true);
    try {
      const [accountsResult, passwordResult] = await Promise.all([
        getLinkedAccountsForUser(userId),
        getUserHasPassword(userId),
      ]);
      setLinkedAccounts(JSON.parse(accountsResult));
      setHasPassword(!!JSON.parse(passwordResult).hasPassword);
    } catch (error: any) {
      setErrorMessage('Failed to load linked accounts');
    } finally {
      setIsLoading(false);
    }
  };

  /**
   * True when unlinking `account` would strip the user's last sign-in method: it is their only
   * linked identity and they have no usable password. The server enforces this too
   * (`unlinkExternalAccount`); disabling the button here just makes the guard visible up front.
   */
  const isLastSignInMethod = (account: LinkedAccount) =>
    !hasPassword && linkedAccounts.length === 1 && linkedAccounts[0]?.id === account.id;

  const handleLinkAccount = async (provider: string) => {
    try {
      const response = await fetch(`/api/auth/link/${provider}`, { method: 'GET', credentials: 'include' });
      if (!response.ok) {
        const error = await response.json().catch(() => ({ error: 'Unknown error' }));
        setErrorMessage(`Failed to initiate account linking: ${error.error || 'Unknown error'}`);
        return;
      }
      signIn(provider, { callbackUrl: '/ade/dashboard/linked-accounts' });
    } catch (error) {
      setErrorMessage('An error occurred while linking the account');
    }
  };

  const handleUnlinkAccount = async (account: LinkedAccount) => {
    const displayName = getProviderDisplayName(account.provider);
    const confirmed = await confirmDialog({
      title: `Unlink ${displayName} Account`,
      message: `Are you sure you want to unlink your ${displayName} account (${account.provider_username || account.provider_email})?`,
    });
    if (!confirmed) return;

    setIsLoading(true);
    setErrorMessage('');
    setSuccessMessage('');

    try {
      const result = await unlinkExternalAccount(userId, account.id);
      const response = JSON.parse(result);
      if (response.success) {
        setSuccessMessage(`Successfully unlinked ${displayName} account`);
        await loadLinkedAccounts();
      } else {
        setErrorMessage(response.error || 'Failed to unlink account');
      }
    } catch (error: any) {
      setErrorMessage(error.message || 'An error occurred while unlinking the account');
    } finally {
      setIsLoading(false);
    }
  };

  const handleOpenPatDialog = (provider: string, accountId?: string) => {
    setPatProvider(provider);
    setEditingAccountId(accountId || null);
    setPatToken('');
    setErrorMessage('');
    setPatDialogOpen(true);
  };

  const handleClosePatDialog = () => {
    setPatDialogOpen(false);
    setPatProvider('');
    setPatToken('');
    setEditingAccountId(null);
  };

  const handleSavePatToken = async () => {
    if (!patToken.trim()) {
      setErrorMessage('Personal Access Token is required');
      return;
    }
    if (!editingAccountId) {
      setErrorMessage('No linked account found. Please link your account first.');
      return;
    }

    setIsLoading(true);
    setErrorMessage('');
    setSuccessMessage('');

    try {
      const result = await updatePersonalAccessToken(userId, editingAccountId, patToken);
      const response = JSON.parse(result);
      if (response.success) {
        setSuccessMessage(`Successfully ${linkedAccounts.find(a => a.id === editingAccountId)?.access_token_suffix ? 'updated' : 'added'} Personal Access Token`);
        await loadLinkedAccounts();
        handleClosePatDialog();
      } else {
        setErrorMessage(response.error || 'Failed to save Personal Access Token');
      }
    } catch (error: any) {
      setErrorMessage(error.message || 'An error occurred while saving the Personal Access Token');
    } finally {
      setIsLoading(false);
    }
  };

  const handleRemovePatToken = async (provider: string, accountId: string) => {
    const account = linkedAccounts.find(a => a.id === accountId);

    const confirmed = await confirmDialog({
      title: `Remove Personal Access Token`,
      message: `Are you sure you want to remove the Personal Access Token for your ${getProviderDisplayName(provider)} account (${account?.provider_username || account?.provider_email})?`,
    });
    if (!confirmed) return;

    setIsLoading(true);
    setErrorMessage('');
    setSuccessMessage('');

    try {
      const result = await removePersonalAccessToken(userId, accountId);
      const response = JSON.parse(result);
      if (response.success) {
        setSuccessMessage(`Successfully removed Personal Access Token for ${getProviderDisplayName(provider)}`);
        await loadLinkedAccounts();
      } else {
        setErrorMessage(response.error || 'Failed to remove Personal Access Token');
      }
    } catch (error: any) {
      setErrorMessage(error.message || 'An error occurred while removing the Personal Access Token');
    } finally {
      setIsLoading(false);
    }
  };

  const isProviderLinked = (provider: string) => linkedAccounts.some((account) => account.provider === provider);

  const formatDate = (dateString: string) => {
    const d = new Date(dateString);
    const datePart = d.toLocaleDateString('en-US', { month: '2-digit', day: '2-digit', year: '2-digit' });
    const timePart = d.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: true });
    return `${datePart} ${timePart}`;
  };

  if (!session) {
    return (
      <div className="p-6">
        <LoadingState minHeightClassName="min-h-64" message="Loading linked accounts..." />
      </div>
    );
  }

  return (
    <>
      <header className="border-b border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800">
        <div className="px-6 py-4">
          <div className="flex items-center justify-between">
            <div>
              <h2 className="text-2xl font-bold text-gray-900 dark:text-white flex items-center gap-2">
                <LinkIcon className="w-6 h-6 text-indigo-600 dark:text-indigo-400" />
                Linked Accounts
              </h2>
              <p className="text-gray-600 dark:text-gray-400 text-sm mt-1">
                Link external accounts for single sign-on and repository access
              </p>
            </div>
          </div>
        </div>
      </header>

      <main className={dashboardMainClass}>
        <div className={dashboardContentStackClass}>

      {/* Success / Error */}
      {successMessage && <Alert variant="success" className="mb-4" onClose={() => setSuccessMessage('')}>{successMessage}</Alert>}
      {errorMessage && <Alert variant="error" className="mb-4" onClose={() => setErrorMessage('')}>{errorMessage}</Alert>}

      {/* Linked Accounts - same list container as Published */}
      <section className="mb-10">
        {linkedAccounts.length === 0 ? (
          <EmptyState
            icon={<LinkIcon className="h-10 w-10" />}
            title="No Linked Accounts"
            description="Link a provider below to sign in with SSO and manage repository access."
            iconContainerClassName="from-cyan-500 to-blue-600 shadow-cyan-500/30"
          />
        ) : (
          <div className={dashboardTableWrapClass}>
            <div className="overflow-x-auto">
              <table className="min-w-full">
                <thead className={dashboardTableTheadClass}>
                  <tr>
                    <th className={dashboardThClass}>Account</th>
                    <th className={dashboardThClass}>Linked</th>
                    <th className={dashboardThClass}>Last login</th>
                    <th className={dashboardThRightClass}>Actions</th>
                  </tr>
                </thead>
                <tbody className={dashboardTbodyClass}>
                  {linkedAccounts.map((account) => {
                    const { Icon, iconClassName } = getProviderBrand(account.provider);
                    const displayName = getProviderDisplayName(account.provider);

                    return (
                      <tr key={account.id} className={dashboardTrHoverClass}>
                        <td className="px-6 py-4 whitespace-nowrap">
                          <div className="flex items-center gap-3">
                            <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-gray-100 dark:bg-gray-700">
                              <Icon size={ICON_SIZE.dense} className={iconClassName} />
                            </div>
                            <div>
                              <div className="text-sm font-semibold text-gray-900 dark:text-white">{displayName}</div>
                              <div className="text-sm text-gray-500 dark:text-gray-400">{account.provider_username || account.provider_email}</div>
                              {isLastSignInMethod(account) && (
                                <div className="mt-1 text-xs text-amber-600 dark:text-amber-400">
                                  Only sign-in method — set a password or link another provider to remove it.
                                </div>
                              )}
                            </div>
                          </div>
                        </td>
                        <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-500 dark:text-gray-400">
                          {formatDate(account.created_at)}
                        </td>
                        <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-500 dark:text-gray-400">
                          {account.last_login_at ? formatDate(account.last_login_at) : '—'}
                        </td>
                        <td className="px-6 py-4 whitespace-nowrap text-right">
                          {(() => {
                            const lastMethod = isLastSignInMethod(account);
                            return (
                              <Button
                                variant="outline"
                                size="sm"
                                onClick={() => handleUnlinkAccount(account)}
                                disabled={isLoading || lastMethod}
                                title={
                                  lastMethod
                                    ? 'This is your only sign-in method. Set a password or link another provider before unlinking it.'
                                    : undefined
                                }
                                className="text-red-600 hover:bg-red-50 hover:text-red-700 dark:text-red-400 dark:hover:bg-red-950/30 dark:hover:text-red-300"
                              >
                                <Trash2 className="h-4 w-4" />
                                Unlink
                              </Button>
                            );
                          })()}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </div>
        )}
      </section>

      {/* Available providers */}
      <section>
        <h2 className="text-sm font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wider mb-4">Add a provider</h2>

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          {providerCards.map((provider) => {
            const { Icon, iconClassName } = getProviderBrand(provider.id);
            const isLinked = isProviderLinked(provider.id);
            const isAvailable = provider.enabled;
            const linkedAccount = linkedAccounts.find(a => a.provider === provider.id);
            const hasPAT = !!linkedAccount?.access_token_suffix;

            return (
              <Card
                key={provider.id}
                className={cn(
                  dashboardPanelClass,
                  'transition-colors shadow-none',
                  !isAvailable && 'opacity-50',
                  isAvailable && 'hover:border-gray-300 dark:hover:border-gray-600'
                )}
              >
                <CardContent className="p-4">
                  <div className="flex items-center justify-between gap-3">
                    <div className="flex min-w-0 items-center gap-3">
                      <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-gray-100 dark:bg-gray-700">
                        <Icon size={ICON_SIZE.dense} className={iconClassName} />
                      </div>
                      <div className="min-w-0">
                        <p className="font-medium text-gray-900 dark:text-white">{provider.label}</p>
                        <div className="mt-0.5 flex flex-wrap gap-1.5">
                          {!isAvailable && <Badge variant="secondary" className="text-xs">Coming soon</Badge>}
                          {isLinked && <Badge variant="success" className="text-xs">Linked</Badge>}
                          {hasPAT && (
                            <Badge variant="secondary" className="text-xs font-mono">
                              <Key className="h-3 w-3 mr-0.5 inline" />
                              PAT ••••••{linkedAccount?.access_token_suffix}
                            </Badge>
                          )}
                        </div>
                      </div>
                    </div>
                    {isLinked ? null : (
                      <Button
                        variant="default"
                        size="sm"
                        onClick={() => handleLinkAccount(provider.id)}
                        disabled={isLoading || !isAvailable}
                        className="shrink-0"
                      >
                        <Plus className="h-4 w-4" />
                        Link
                      </Button>
                    )}
                  </div>

                  {/* PAT for GitHub/GitLab when linked */}
                  {PAT_PROVIDERS.has(provider.id) && isAvailable && isLinked && (
                    <div className="mt-4 pt-4 border-t border-gray-200 dark:border-gray-700 flex items-center justify-between gap-4">
                      <div className="min-w-0">
                        <div className="text-xs font-medium text-gray-600 dark:text-gray-400 flex items-center gap-1.5">
                          <Key className="h-3.5 w-3.5 text-gray-500 dark:text-gray-400 shrink-0" />
                          Personal Access Token
                        </div>
                        <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">
                          {linkedAccount?.access_token_suffix ? (
                            <>PAT set (ends in <span className="font-mono font-medium text-gray-700 dark:text-gray-300">••••••{linkedAccount.access_token_suffix}</span>).</>
                          ) : (
                            'Optional: add a PAT for direct repo access.'
                          )}
                        </p>
                      </div>
                      <div className="flex items-center gap-1.5 shrink-0">
                        <Button
                          variant="outline"
                          size="sm"
                          onClick={() => handleOpenPatDialog(provider.id, linkedAccount?.id)}
                          disabled={isLoading}
                          className="text-xs h-7"
                        >
                          {linkedAccount?.access_token_suffix ? 'Update' : 'Add'}
                        </Button>
                        {linkedAccount?.access_token_suffix && (
                          <Button variant="ghost" size="sm" onClick={() => handleRemovePatToken(provider.id, linkedAccount.id)} disabled={isLoading} className="text-xs h-7 text-red-600 hover:text-red-700 dark:text-red-400">
                            Remove
                          </Button>
                        )}
                      </div>
                    </div>
                  )}
                </CardContent>
              </Card>
            );
          })}
        </div>

        <Alert variant="info" className="mt-6">
          You can link multiple providers. Once linked, you can sign in with any of them.
        </Alert>
      </section>

      {/* Personal Access Token Dialog */}
      <Dialog open={patDialogOpen} onOpenChange={(open) => !open && handleClosePatDialog()}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{linkedAccounts.find(a => a.id === editingAccountId)?.access_token_suffix ? 'Update' : 'Add'} Personal Access Token</DialogTitle>
            <DialogDescription>
              {patProvider && `${getProviderDisplayName(patProvider)} · ${linkedAccounts.find(a => a.id === editingAccountId)?.provider_username || linkedAccounts.find(a => a.id === editingAccountId)?.provider_email}`}
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4 py-4">
            <div className="space-y-2">
              <Label htmlFor="patToken">Token</Label>
              <Input id="patToken" type="password" value={patToken} onChange={(e) => setPatToken(e.target.value)} placeholder="Paste your token" autoFocus />
              <p className="text-xs text-gray-500 dark:text-gray-400">Used to authenticate with {getProviderDisplayName(patProvider) || 'the provider'}'s API.</p>
            </div>
            {patProvider === 'github' && (
              <Alert variant="info">
                <strong>GitHub scopes:</strong> repo (or public_repo), read:org, read:user, user:email
              </Alert>
            )}
            {patProvider === 'gitlab' && (
              <Alert variant="info">
                <strong>GitLab scopes:</strong> read_api, read_repository, read_user
              </Alert>
            )}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={handleClosePatDialog}>Cancel</Button>
            <Button onClick={handleSavePatToken} disabled={isLoading}>
              {linkedAccounts.find(a => a.id === editingAccountId)?.access_token_suffix ? 'Update token' : 'Add token'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
        </div>
      </main>
    </>
  );
};

export default LinkedAccountsClient;
