'use client';

import * as React from 'react';
import Link from 'next/link';
import { Copy, FolderOpen, Globe, Plus, Trash2, X } from 'lucide-react';
import { toast } from 'sonner';
import { cn } from '@lib/utils';
import { Button } from '../../../ui/Button';
import { Input } from '../../../ui/Input';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '../../../ui/Dialog';
import { useDialog } from '../../../providers/DialogProvider';
import { destructiveConfirm } from '../../../dialogs/destructiveConfirm';
import {
  mcpCollectionCreateBody,
  mcpCollectionPublicUrl,
  mcpCollectionsFromPayload,
  type McpCollection,
} from './mcpCollectionUi';

export interface McpCollectionsPanelProps {
  /** Endpoint ids currently visible in the catalog (used when creating from selection). */
  selectedEndpointIds?: string[];
}

async function fetchCollections(): Promise<{ collections: McpCollection[]; tenantSlug: string }> {
  const res = await fetch('/api/mcp/collections', { credentials: 'include' });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(typeof data.error === 'string' ? data.error : res.statusText);
  }
  return {
    collections: mcpCollectionsFromPayload(data),
    tenantSlug: typeof data.tenantSlug === 'string' ? data.tenantSlug : '',
  };
}

/**
 * Curated collections — create, publish, and manage named endpoint lists for the tenant catalog.
 */
export function McpCollectionsPanel({
  selectedEndpointIds = [],
}: McpCollectionsPanelProps): React.ReactElement {
  const { confirm, prompt } = useDialog();
  const [collections, setCollections] = React.useState<McpCollection[]>([]);
  const [tenantSlug, setTenantSlug] = React.useState('');
  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState<string | null>(null);
  const [panelOpen, setPanelOpen] = React.useState(false);
  const [createOpen, setCreateOpen] = React.useState(false);
  const [createName, setCreateName] = React.useState('');
  const [createDescription, setCreateDescription] = React.useState('');
  const [createPublished, setCreatePublished] = React.useState(false);
  const [saving, setSaving] = React.useState(false);

  const reload = React.useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const result = await fetchCollections();
      setCollections(result.collections);
      setTenantSlug(result.tenantSlug);
    } catch (e) {
      setCollections([]);
      setError(e instanceof Error ? e.message : 'Could not load collections');
    } finally {
      setLoading(false);
    }
  }, []);

  React.useEffect(() => {
    void reload();
  }, [reload]);

  const handleCreate = async () => {
    const name = createName.trim();
    if (!name) return;
    setSaving(true);
    setError(null);
    try {
      const res = await fetch('/api/mcp/collections', {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(
          mcpCollectionCreateBody(name, selectedEndpointIds, {
            description: createDescription,
            isPublished: createPublished,
          }),
        ),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        throw new Error(typeof data.error === 'string' ? data.error : res.statusText);
      }
      setCreateOpen(false);
      setCreateName('');
      setCreateDescription('');
      setCreatePublished(false);
      toast.success('Collection created');
      await reload();
    } catch (e) {
      const message = e instanceof Error ? e.message : 'Could not create collection';
      setError(message);
      toast.error(message);
    } finally {
      setSaving(false);
    }
  };

  /**
   * Rename a collection from the prompt dialog.
   *
   * The PATCH runs inside the dialog (`perform`), so a name the API refuses is reported
   * under the field rather than in the panel's banner after the dialog has gone.
   */
  const handleRename = async (collection: McpCollection) => {
    setError(null);
    await prompt({
      title: `Rename "${collection.name}"`,
      label: 'Collection name',
      defaultValue: collection.name,
      helperText: 'Shown wherever this collection is published.',
      confirmLabel: 'Rename collection',
      validate: (next) =>
        next === collection.name ? 'That is already the name of this collection.' : null,
      perform: async (next) => {
        const res = await fetch(`/api/mcp/collections/${encodeURIComponent(collection.id)}`, {
          method: 'PATCH',
          credentials: 'include',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name: next }),
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) {
          throw new Error(typeof data.error === 'string' ? data.error : res.statusText);
        }
        toast.success('Collection renamed');
        await reload();
      },
    });
  };

  const handleTogglePublish = async (collection: McpCollection) => {
    setError(null);
    try {
      const res = await fetch(`/api/mcp/collections/${encodeURIComponent(collection.id)}`, {
        method: 'PATCH',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ isPublished: !collection.isPublished }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        throw new Error(typeof data.error === 'string' ? data.error : res.statusText);
      }
      toast.success(collection.isPublished ? 'Collection unpublished' : 'Collection published');
      await reload();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not update collection');
    }
  };

  const handleDelete = async (collection: McpCollection) => {
    const confirmed = await confirm(
      destructiveConfirm({
        action: 'Delete',
        noun: 'collection',
        name: collection.name,
        consequence:
          'The collection and its public URL stop working. The endpoints it groups stay in the catalog.',
      })
    );
    if (!confirmed) return;
    setError(null);
    try {
      const res = await fetch(`/api/mcp/collections/${encodeURIComponent(collection.id)}`, {
        method: 'DELETE',
        credentials: 'include',
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        throw new Error(typeof data.error === 'string' ? data.error : res.statusText);
      }
      toast.success('Collection deleted');
      await reload();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not delete collection');
    }
  };

  const handleCopyShareLink = async (collection: McpCollection) => {
    if (!tenantSlug) {
      toast.error('Tenant slug unavailable for share link');
      return;
    }
    const url = mcpCollectionPublicUrl(tenantSlug, collection.slug);
    try {
      await navigator.clipboard.writeText(url);
      toast.success('Share link copied');
    } catch {
      toast.message(url);
    }
  };

  return (
    <>
      <div className="flex flex-wrap items-center gap-2">
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="h-9"
          onClick={() => setCreateOpen(true)}
        >
          <Plus className="h-4 w-4" aria-hidden />
          New collection
        </Button>

        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="h-9"
          aria-expanded={panelOpen}
          onClick={() => setPanelOpen((v) => !v)}
        >
          <FolderOpen className="h-4 w-4" aria-hidden />
          Collections ({collections.length})
        </Button>
      </div>

      {panelOpen ? (
        <div className="border-t border-gray-200 bg-white px-6 py-4 dark:border-gray-700 dark:bg-gray-800">
          {error ? (
            <p className="mb-3 text-sm text-red-600 dark:text-red-400" role="alert">
              {error}
            </p>
          ) : null}
          {loading ? (
            <p className="text-sm text-gray-500 dark:text-gray-400">Loading collections…</p>
          ) : collections.length === 0 ? (
            <p className="text-sm text-gray-500 dark:text-gray-400">
              No collections yet. Group related endpoints into a named list for navigation and sharing.
            </p>
          ) : (
            <ul className="divide-y divide-gray-200 rounded-md border border-gray-200 dark:divide-gray-700 dark:border-gray-700">
              {collections.map((collection) => (
                <li
                  key={collection.id}
                  className="flex flex-wrap items-center justify-between gap-2 px-3 py-2"
                >
                  <div className="min-w-0">
                    <p className="truncate text-sm font-medium text-gray-900 dark:text-white">
                      {collection.name}
                      {collection.isPublished ? (
                        <span className="ml-2 text-xs font-normal text-emerald-600 dark:text-emerald-400">
                          published
                        </span>
                      ) : null}
                    </p>
                    <p className="truncate text-xs text-gray-500 dark:text-gray-400">
                      {collection.memberCount} endpoint{collection.memberCount === 1 ? '' : 's'}
                      {collection.description ? ` · ${collection.description}` : ''}
                    </p>
                  </div>
                  <div className="flex items-center gap-1">
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      className="h-8"
                      title="Rename collection"
                      onClick={() => void handleRename(collection)}
                    >
                      Rename
                    </Button>
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      className="h-8"
                      title={collection.isPublished ? 'Unpublish collection' : 'Publish collection'}
                      onClick={() => void handleTogglePublish(collection)}
                    >
                      <Globe className="h-4 w-4" aria-hidden />
                      <span className="sr-only">
                        {collection.isPublished ? 'Unpublish' : 'Publish'}
                      </span>
                    </Button>
                    {collection.isPublished && tenantSlug ? (
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        className="h-8"
                        title="Copy public share link"
                        onClick={() => void handleCopyShareLink(collection)}
                      >
                        <Copy className="h-4 w-4" aria-hidden />
                        <span className="sr-only">Copy share link</span>
                      </Button>
                    ) : null}
                    {tenantSlug ? (
                      <Link
                        href={mcpCollectionPublicUrl(tenantSlug, collection.slug)}
                        className={cn(
                          'inline-flex h-8 items-center rounded-md px-2 text-xs font-medium text-indigo-600',
                          'hover:bg-indigo-50 dark:text-indigo-300 dark:hover:bg-indigo-900/30',
                        )}
                        target="_blank"
                        rel="noreferrer"
                      >
                        View
                      </Link>
                    ) : null}
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      className="h-8 text-red-600 hover:text-red-700 dark:text-red-400"
                      title="Delete collection"
                      onClick={() => void handleDelete(collection)}
                    >
                      <Trash2 className="h-4 w-4" aria-hidden />
                      <span className="sr-only">Delete</span>
                    </Button>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </div>
      ) : null}

      <Dialog open={createOpen} onOpenChange={setCreateOpen}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>Create collection</DialogTitle>
            <DialogDescription>
              Group related MCP endpoints into a named list. You can publish it later for a shareable
              browse view that only shows public endpoints.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3 py-2">
            <label className="block text-sm font-medium text-gray-700 dark:text-gray-300" htmlFor="collection-name">
              Name
            </label>
            <Input
              id="collection-name"
              value={createName}
              onChange={(e) => setCreateName(e.target.value)}
              placeholder="e.g. Approved geo tools"
              autoFocus
            />
            <label className="block text-sm font-medium text-gray-700 dark:text-gray-300" htmlFor="collection-description">
              Description (optional)
            </label>
            <Input
              id="collection-description"
              value={createDescription}
              onChange={(e) => setCreateDescription(e.target.value)}
              placeholder="Short note for your team"
            />
            {selectedEndpointIds.length > 0 ? (
              <p className="text-xs text-gray-500 dark:text-gray-400">
                Includes {selectedEndpointIds.length} endpoint
                {selectedEndpointIds.length === 1 ? '' : 's'} from the current catalog view.
              </p>
            ) : null}
            <label className="flex items-center gap-2 text-sm text-gray-600 dark:text-gray-300">
              <input
                type="checkbox"
                checked={createPublished}
                onChange={(e) => setCreatePublished(e.target.checked)}
                className="rounded border-gray-300"
              />
              Publish immediately (public endpoints only on browse)
            </label>
          </div>
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={() => setCreateOpen(false)}>
              <X className="h-4 w-4" aria-hidden />
              Cancel
            </Button>
            <Button
              type="button"
              disabled={!createName.trim() || saving}
              onClick={() => void handleCreate()}
            >
              Create
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
