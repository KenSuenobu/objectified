'use client';

/**
 * Ship → Published versions (HIVE-8.1, #5327).
 *
 * Authority: `docs/mockups/ship/published.html`, whose **Notes → Keeps (1:1)** list is this
 * ticket's acceptance criteria; DESIGN.md §5.3 (page header), §8 (list page: header → toolbar
 * → table → foot) and §3.1 (status vocabulary).
 *
 * ### What this screen is
 *
 * Every locked, published revision in the workspace, and the three things a consumer-facing
 * publication has that a draft does not: an access URL, a visibility, and a hosted mock. It is
 * a *ship* surface — nothing is authored here. There is deliberately no unpublish and no
 * delete: both belong to the revision, and the revision is edited on Build → Versions.
 *
 * ### What it owns, and what it no longer decides
 *
 * It owns the read, the two writes (visibility, and the mock toggle it delegates), which
 * overlay is open, and the clipboard. It owns none of the rules: the four viewer URLs, the
 * search predicate, the confirm's copy, the gate on the View fly-out, the foot's sentence and
 * the lifecycle pill are all `publishedModel`, where they are tested without rendering a
 * screen. The 707-line component this replaces decided every one of them inline.
 *
 * ### Five things this fixes rather than restyles
 *
 * 1. **A failed read looked like an empty workspace.** `getPublishedVersionsForTenant` used to
 *    answer a database outage with `[]`, and the screen drew "No published versions" over it.
 *    The read reports its failure now, and the table draws it with a retry.
 * 2. **The copied state was invisible.** A `copiedUrl` state was set and cleared after two
 *    seconds and never rendered; the only way to copy an access URL was the kebab, and nothing
 *    confirmed it. The Access URL cell is the copy button now.
 * 3. **The View fly-out was mouse-only.** It opened on `mouseenter`, closed on `mouseleave`,
 *    and had no keyboard route in or out. It is a Radix `DropdownMenu.Sub` now.
 * 4. **A failed visibility change opened a second dialog.** The screen answered one modal with
 *    another; the failure is the mockup's danger banner now, and it names what went wrong.
 * 5. **The search box vanished with the rows.** Loading, empty and search-miss each replaced
 *    the whole table *and* its toolbar, so the only way out of a bad search was to reload. All
 *    three are inside the table's card now.
 */

import * as React from 'react';
import Link from 'next/link';
import { KeyRound } from 'lucide-react';
import { toast } from 'sonner';

import { useAuthSession } from '@lib/auth/session-client';
import type { ShortcutBinding } from '@lib/shortcuts';
import {
  getApiKeysForTenant,
  getPublishedVersionsForTenant,
  updateVersionVisibility,
} from '@lib/db/helper';
import { buildMockBaseUrl } from '@lib/mock/mockUrl';

import PageHeader from '@/app/components/shell/PageHeader';
import { Page, PageBody } from '@/app/components/shell/pageChrome';
import { useShortcuts } from '@/app/hooks/useShortcuts';
import { useMockUsage } from '@/app/hooks/useMockUsage';
import { Alert, AlertDescription } from '@/app/components/ui/Alert';
import { Button } from '@/app/components/ui/Button';
import {
  DataTableFoot,
  DataTableSearch,
  DataTableToolbar,
} from '@/app/components/ui/DataTable';
import { EmptyState, GatedState } from '@/app/components/ui/EmptyState';
import { useDialog } from '@/app/components/providers/DialogProvider';
import type { VersionMockChange } from '@/app/components/ade/dashboard/VersionMockCell';
import {
  clearStoredPreviewApiKey,
  getStoredPreviewApiKey,
  setStoredPreviewApiKey,
} from '@/app/utils/preview-api-key-storage';
import {
  API_KEYS_HREF,
  COPIED_URL_RESET_MS,
  COPY_URL_FAILURE,
  COPY_URL_SUCCESS,
  HOME_HREF,
  PREVIEW_KEY_CLEARED,
  PUBLISHED_EMPTY,
  PUBLISHED_NO_MATCHES,
  PUBLISHED_NO_TENANT,
  PublishedApiKeyDialog,
  PublishedTable,
  VERSIONS_HREF,
  VISIBILITY_UNKNOWN_ERROR,
  hasUsableApiKey,
  isPublishedListFiltered,
  nextVisibility,
  publishedFootLabel,
  publishedSummaryLine,
  publishedViewUrl,
  searchPublishedVersions,
  visibilityChangedToast,
  visibilityConfirm,
  visibilityErrorMessage,
  withApiKey,
  type PublishedApiKeySummary,
  type PublishedRowAction,
  type PublishedVersion,
  type PublishedViewKind,
} from '@/app/components/ade/published';

export interface PublishedVersionsProps {
  /** The REST base URL, resolved on the server per request (see `page.tsx`). */
  restApiBaseUrl: string;
  /** Public base URL of the hosted mock runtime (#4443, SIM-2.2), e.g. `https://mock.example.com`. */
  mockApiBaseUrl: string;
}

/**
 * Render the Published surface. See {@link PublishedVersionsProps}.
 *
 * @returns The page.
 */
export default function PublishedVersions({
  restApiBaseUrl,
  mockApiBaseUrl,
}: PublishedVersionsProps) {
  const { data: session } = useAuthSession();
  const { confirm: confirmDialog } = useDialog();
  const currentTenantId = (session?.user as { current_tenant_id?: string } | undefined)
    ?.current_tenant_id;

  // ---- the list ---------------------------------------------------------------------------

  const [versions, setVersions] = React.useState<PublishedVersion[]>([]);
  const [loading, setLoading] = React.useState(true);
  const [loadError, setLoadError] = React.useState<string | null>(null);
  const [query, setQuery] = React.useState('');

  const [apiKeys, setApiKeys] = React.useState<PublishedApiKeySummary[]>([]);
  const [changingVisibility, setChangingVisibility] = React.useState<string | null>(null);
  const [visibilityError, setVisibilityError] = React.useState<string | null>(null);
  const [copiedVersionId, setCopiedVersionId] = React.useState<string | null>(null);

  const searchRef = React.useRef<HTMLInputElement | null>(null);
  const copyResetRef = React.useRef<ReturnType<typeof setTimeout> | null>(null);

  const loadPublishedVersions = React.useCallback(async () => {
    if (!currentTenantId) {
      setVersions([]);
      setLoadError(null);
      setLoading(false);
      return;
    }
    setLoading(true);
    try {
      const payload = JSON.parse(await getPublishedVersionsForTenant(currentTenantId)) as {
        success?: boolean;
        versions?: PublishedVersion[];
        error?: string;
      };
      if (payload?.success === false) {
        setVersions([]);
        setLoadError(payload.error || 'The published versions could not be read.');
        return;
      }
      setVersions(Array.isArray(payload?.versions) ? payload.versions : []);
      setLoadError(null);
    } catch (error) {
      console.error('Failed to load published versions:', error);
      setVersions([]);
      setLoadError(error instanceof Error ? error.message : 'The published versions could not be read.');
    } finally {
      setLoading(false);
    }
  }, [currentTenantId]);

  React.useEffect(() => {
    void loadPublishedVersions();
  }, [loadPublishedVersions]);

  React.useEffect(() => {
    if (!currentTenantId) {
      setApiKeys([]);
      return;
    }
    let cancelled = false;
    void getApiKeysForTenant(currentTenantId).then((result) => {
      if (cancelled) return;
      try {
        const parsed = JSON.parse(result) as PublishedApiKeySummary[];
        setApiKeys(Array.isArray(parsed) ? parsed : []);
      } catch {
        setApiKeys([]);
      }
    });
    return () => {
      cancelled = true;
    };
  }, [currentTenantId]);

  // A pending "copied" reset must not fire into an unmounted screen.
  React.useEffect(
    () => () => {
      if (copyResetRef.current) clearTimeout(copyResetRef.current);
    },
    []
  );

  /** 30-day mock usage across the tenant's published versions (#4443, SIM-2.2). */
  const { seriesByVersion: mockUsageByVersion } = useMockUsage({
    enabled: Boolean(currentTenantId),
  });

  const visible = React.useMemo(
    () => searchPublishedVersions(versions, query),
    [versions, query]
  );

  const menuContext = React.useMemo(
    () => ({ hasApiKey: hasUsableApiKey(apiKeys) }),
    [apiKeys]
  );

  // ---- the remembered preview key -----------------------------------------------------------

  const [apiKeyDialog, setApiKeyDialog] = React.useState<{
    version: PublishedVersion;
    kind: PublishedViewKind;
  } | null>(null);
  const [apiKeyInput, setApiKeyInput] = React.useState('');
  const [rememberApiKey, setRememberApiKey] = React.useState(true);
  /** Bumps when the stored key changes, so the dialog re-reads `localStorage`. */
  const [storedKeyRevision, setStoredKeyRevision] = React.useState(0);

  const hasSavedKey = React.useMemo(() => {
    void storedKeyRevision;
    return Boolean(currentTenantId && getStoredPreviewApiKey(currentTenantId));
  }, [currentTenantId, storedKeyRevision]);

  /** Open one viewer in a new tab, with the key appended when there is one. */
  const openViewer = React.useCallback(
    (version: PublishedVersion, kind: PublishedViewKind, apiKey: string | null) => {
      window.open(withApiKey(publishedViewUrl(restApiBaseUrl, version, kind), apiKey), '_blank');
    },
    [restApiBaseUrl]
  );

  /** Ask for a key, seeded empty and with "remember" back on. */
  const promptForKey = React.useCallback((version: PublishedVersion, kind: PublishedViewKind) => {
    setApiKeyInput('');
    setRememberApiKey(true);
    setApiKeyDialog({ version, kind });
  }, []);

  /**
   * Open a viewer, prompting for a key only when the revision is private and this device does
   * not already remember one.
   */
  const openWithKeyIfNeeded = React.useCallback(
    (version: PublishedVersion, kind: PublishedViewKind) => {
      if (version.visibility !== 'private') {
        openViewer(version, kind, null);
        return;
      }
      const stored = getStoredPreviewApiKey(currentTenantId);
      if (stored) {
        openViewer(version, kind, stored);
        return;
      }
      promptForKey(version, kind);
    },
    [currentTenantId, openViewer, promptForKey]
  );

  const submitApiKey = React.useCallback(() => {
    if (!apiKeyDialog) return;
    const key = apiKeyInput.trim();
    if (!key) return;
    openViewer(apiKeyDialog.version, apiKeyDialog.kind, key);
    if (rememberApiKey && currentTenantId) {
      setStoredPreviewApiKey(currentTenantId, key);
      setStoredKeyRevision((revision) => revision + 1);
    }
    setApiKeyDialog(null);
    setApiKeyInput('');
  }, [apiKeyDialog, apiKeyInput, currentTenantId, openViewer, rememberApiKey]);

  const clearSavedKey = React.useCallback(() => {
    if (!currentTenantId) return;
    clearStoredPreviewApiKey(currentTenantId);
    setStoredKeyRevision((revision) => revision + 1);
    toast.success(PREVIEW_KEY_CLEARED);
  }, [currentTenantId]);

  // ---- the writes ---------------------------------------------------------------------------

  const copyAccessUrl = React.useCallback(
    async (version: PublishedVersion) => {
      try {
        await navigator.clipboard.writeText(publishedViewUrl(restApiBaseUrl, version, 'openapi'));
        setCopiedVersionId(version.id);
        toast.success(COPY_URL_SUCCESS);
        if (copyResetRef.current) clearTimeout(copyResetRef.current);
        copyResetRef.current = setTimeout(() => setCopiedVersionId(null), COPIED_URL_RESET_MS);
      } catch (error) {
        console.error('Failed to copy URL:', error);
        toast.error(COPY_URL_FAILURE);
      }
    },
    [restApiBaseUrl]
  );

  const toggleVisibility = React.useCallback(
    async (version: PublishedVersion) => {
      const next = nextVisibility(version);
      if (!(await confirmDialog(visibilityConfirm(version)))) return;

      setVisibilityError(null);
      setChangingVisibility(version.id);
      try {
        const response = JSON.parse(await updateVersionVisibility(version.id, next)) as {
          success?: boolean;
          error?: string;
        };
        if (response?.success) {
          setVersions((current) =>
            current.map((row) => (row.id === version.id ? { ...row, visibility: next } : row))
          );
          toast.success(visibilityChangedToast(next));
          return;
        }
        setVisibilityError(visibilityErrorMessage(response?.error));
      } catch (error) {
        console.error('Failed to update visibility:', error);
        setVisibilityError(VISIBILITY_UNKNOWN_ERROR);
      } finally {
        setChangingVisibility(null);
      }
    },
    [confirmDialog]
  );

  /** Fold a successful mock toggle round-trip back into the row (#4443). */
  const handleMockChanged = React.useCallback(
    (versionRecordId: string, change: VersionMockChange) => {
      setVersions((current) =>
        current.map((row) =>
          row.id === versionRecordId ? { ...row, mock_enabled: change.mockEnabled } : row
        )
      );
    },
    []
  );

  const handleRowAction = React.useCallback(
    (action: PublishedRowAction, version: PublishedVersion) => {
      switch (action) {
        case 'openapi':
        case 'arazzo':
        case 'json':
        case 'swagger':
          openWithKeyIfNeeded(version, action);
          break;
        case 'key':
          // The row's key button always asks, so a remembered key can be replaced.
          promptForKey(version, 'openapi');
          break;
        case 'copy':
          void copyAccessUrl(version);
          break;
        case 'visibility':
          void toggleVisibility(version);
          break;
      }
    },
    [copyAccessUrl, openWithKeyIfNeeded, promptForKey, toggleVisibility]
  );

  /** Where the hosted mock for one row is served from — the REST `_mock_base_url` shape (#4422). */
  const mockBaseUrl = React.useCallback(
    (version: PublishedVersion) =>
      buildMockBaseUrl(mockApiBaseUrl, version.tenant_slug, version.project_slug, version.version_id),
    [mockApiBaseUrl]
  );

  /* `/` — DESIGN.md §8's list-page key. Registered only while a workspace is chosen, because
     it acts on a list that does not exist without one. There is no `N`: nothing is created
     here. */
  const shortcuts = React.useMemo<readonly ShortcutBinding[]>(
    () =>
      currentTenantId
        ? [
            {
              id: 'published-filter',
              scope: 'list',
              description: 'Filter published versions',
              chord: { key: '/' },
              run: () => searchRef.current?.focus(),
            },
          ]
        : [],
    [currentTenantId]
  );
  useShortcuts(shortcuts);

  // ---- the page -----------------------------------------------------------------------------

  const toolbar = (
    <DataTableToolbar data-testid="published-toolbar">
      <DataTableSearch
        ref={searchRef}
        value={query}
        onChange={(event) => setQuery(event.target.value)}
        placeholder="Search by project name, version, or description…  ( / )"
        aria-label="Search published versions"
        data-testid="published-search"
      />
    </DataTableToolbar>
  );

  const footer =
    versions.length > 0 ? (
      <DataTableFoot data-testid="published-foot">
        <span>
          {publishedFootLabel(visible.length, versions.length)}
          {isPublishedListFiltered(query, visible.length, versions.length) ? (
            <span className="pub-foot__filtered"> (filtered)</span>
          ) : null}
        </span>
        <span className="pub-foot__hint">
          Visibility is the only change made here — publish and unpublish live on Versions.
        </span>
      </DataTableFoot>
    ) : undefined;

  const empty =
    versions.length === 0 ? (
      <EmptyState
        variant="compact"
        surface={false}
        title={PUBLISHED_EMPTY.title}
        description={PUBLISHED_EMPTY.description}
        action={
          <Button asChild data-testid="published-empty-versions">
            <Link href={VERSIONS_HREF}>{PUBLISHED_EMPTY.actionLabel}</Link>
          </Button>
        }
      />
    ) : (
      <EmptyState
        variant="compact"
        surface={false}
        tone="neutral"
        title={PUBLISHED_NO_MATCHES.title}
        description={PUBLISHED_NO_MATCHES.description}
        action={
          <Button variant="outline" onClick={() => setQuery('')} data-testid="published-clear-search">
            Clear search
          </Button>
        }
      />
    );

  return (
    <Page>
      <PageHeader
        breadcrumb={[{ label: 'Home', href: HOME_HREF }, { label: 'Ship' }, { label: 'Published' }]}
        title="Published versions"
        description={publishedSummaryLine(versions)}
        actions={
          <Button variant="outline" asChild data-testid="published-api-keys">
            <Link href={API_KEYS_HREF}>
              <KeyRound aria-hidden />
              API keys
            </Link>
          </Button>
        }
      />

      <PageBody>
        {!currentTenantId ? (
          <GatedState
            title={PUBLISHED_NO_TENANT.title}
            description={PUBLISHED_NO_TENANT.description}
          />
        ) : (
          <>
            {visibilityError ? (
              <Alert
                variant="danger"
                data-testid="published-visibility-error"
                actions={
                  <Button variant="ghost" size="sm" onClick={() => setVisibilityError(null)}>
                    Dismiss
                  </Button>
                }
              >
                <AlertDescription>{visibilityError}</AlertDescription>
              </Alert>
            ) : null}

            <PublishedTable
              versions={visible}
              loading={loading}
              error={loadError}
              onRetry={() => void loadPublishedVersions()}
              menuContext={menuContext}
              changingVisibility={changingVisibility}
              copiedVersionId={copiedVersionId}
              mockBaseUrl={mockBaseUrl}
              mockUsageByVersion={mockUsageByVersion}
              onMockChanged={handleMockChanged}
              onToggleVisibility={(version) => void toggleVisibility(version)}
              onCopyAccessUrl={(version) => void copyAccessUrl(version)}
              onRowAction={handleRowAction}
              toolbar={toolbar}
              footer={footer}
              empty={empty}
            />
          </>
        )}
      </PageBody>

      <PublishedApiKeyDialog
        open={apiKeyDialog !== null}
        onClose={() => setApiKeyDialog(null)}
        value={apiKeyInput}
        onValueChange={setApiKeyInput}
        remember={rememberApiKey}
        onRememberChange={setRememberApiKey}
        hasSavedKey={hasSavedKey}
        onClearSavedKey={clearSavedKey}
        onSubmit={submitApiKey}
      />
    </Page>
  );
}
