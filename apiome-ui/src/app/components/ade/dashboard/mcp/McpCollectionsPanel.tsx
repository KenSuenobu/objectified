'use client';

/**
 * Curated MCP collections (V2-MCP-36.4 / MCAT-22.4; redesigned HIVE-7.7, #5324).
 *
 * Authority: `docs/mockups/sources/mcp-servers.html` — the right half of the strips row, whose
 * **Notes → Keeps (1:1)** list fixes the contract: *New collection*, a `Collections (n)`
 * disclosure, rows carrying a published tag, the member count and the description, and
 * Rename / Publish-Unpublish / Copy share link / View ↗ / Delete per row; plus a *Create
 * collection* dialog with the "Includes n endpoint(s) from the current catalog view" hint and
 * *Publish immediately*.
 *
 * ### The contract this keeps: membership is fixed at creation
 *
 * A collection is a **list of endpoints**, not a saved filter. It is created from whatever the
 * catalog view is showing at that moment and then never moves: narrowing the filters afterwards
 * does not shrink it, and registering a new server does not join it. That is the difference
 * between this panel and the saved searches beside it, and it is the one thing about a collection
 * a reader can get wrong — so the create dialog now *names the endpoints* it is about to freeze
 * in, and says in a sentence that the list does not follow the view. Nothing about the behaviour
 * changed; what changed is that the screen admits to it.
 *
 * ### What the redesign changed
 *
 * 1. **The strip had no panel.** Same as the saved searches: a bare row inside a page-drawn
 *    `border-b border-gray-200 bg-white` band, now a `ui/Card` with a titled header.
 * 2. **"published" was a green word** (`text-emerald-600 dark:text-emerald-400`) and the View
 *    link was `text-indigo-600 … hover:bg-indigo-50`. They are `Badge status="published"` and
 *    `Button variant="ghost" asChild`, so both take the tones the rest of the product uses.
 * 3. **Delete was ghost red text** (`text-red-600 hover:text-red-700`); the row's danger action
 *    is `.mcp-strip__danger`, one rule rather than a palette pair per button. The confirm itself
 *    is unchanged — it already named the collection and its consequence.
 * 4. **Errors were a red sentence.** They are `ui/Alert`.
 * 5. **The create dialog's hint was a bare count.** It lists the members (up to a cap, then
 *    "and n more"), which is what the mockup shows and what makes the fixed-at-creation rule
 *    checkable before pressing Create.
 */

import * as React from 'react';
import Link from 'next/link';
import { ArrowUpRight, Copy, Globe, Plus, Trash2 } from 'lucide-react';
import { toast } from 'sonner';
import { Alert } from '../../../ui/Alert';
import { Badge } from '../../../ui/Badge';
import { Button } from '../../../ui/Button';
import { Card } from '../../../ui/Card';
import { Checkbox } from '../../../ui/Checkbox';
import { FormField } from '../../../ui/FormField';
import { Input } from '../../../ui/Input';
import { Label } from '../../../ui/Label';
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
  mcpCollectionMembershipHint,
  mcpCollectionPublicUrl,
  mcpCollectionsFromPayload,
  type McpCatalogEndpointRef,
  type McpCollection,
} from './mcpCollectionUi';

export interface McpCollectionsPanelProps {
  /**
   * The endpoints currently visible in the catalog — the list a new collection is frozen from.
   *
   * The *view*, not the whole catalog: creating from a filtered view is how an operator builds
   * "the four geo servers" without ticking four boxes.
   */
  visibleEndpoints?: readonly McpCatalogEndpointRef[];
}

/** What the panel says while it is reading, and when the workspace has no collections. */
export const COLLECTIONS_LOADING = 'Loading collections…';
export const COLLECTIONS_EMPTY =
  'No collections yet. Group related endpoints into a named list for navigation and sharing.';

/** The sentence that states the contract, printed in the create dialog. */
export const COLLECTIONS_FIXED_MEMBERSHIP_NOTE =
  'Membership is fixed when the collection is created — changing the filters later does not change it.';

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

export function McpCollectionsPanel({
  visibleEndpoints = [],
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

  const selectedEndpointIds = React.useMemo(
    () => visibleEndpoints.map((endpoint) => endpoint.id),
    [visibleEndpoints],
  );

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
      helperText: 'Members and publish state are unchanged.',
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
      }),
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
    <Card className="mcp-strip" data-testid="mcp-collections">
      <div className="mcp-strip__head">
        <div className="mcp-strip__lead">
          <p className="mcp-strip__label">Collections</p>
          <p className="mcp-strip__note">Curated lists you can publish to Browse</p>
        </div>
        <div className="mcp-strip__actions">
          <Button type="button" variant="outline" size="sm" onClick={() => setCreateOpen(true)}>
            <Plus aria-hidden />
            New collection
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            aria-expanded={panelOpen}
            onClick={() => setPanelOpen((v) => !v)}
          >
            Collections ({collections.length})
          </Button>
        </div>
      </div>

      {panelOpen ? (
        <div className="mcp-strip__body">
          {error ? <Alert variant="danger">{error}</Alert> : null}
          {loading ? (
            <p className="mcp-strip__note">{COLLECTIONS_LOADING}</p>
          ) : collections.length === 0 ? (
            <p className="mcp-strip__note">{COLLECTIONS_EMPTY}</p>
          ) : (
            <ul className="mcp-strip__list">
              {collections.map((collection) => (
                <li key={collection.id} className="mcp-strip__row">
                  <div className="mcp-strip__row-main">
                    <div className="mcp-strip__row-title">
                      {collection.name}
                      {collection.isPublished ? (
                        <Badge status="published">published</Badge>
                      ) : null}
                    </div>
                    <p className="mcp-strip__row-sub">
                      {collection.memberCount} endpoint{collection.memberCount === 1 ? '' : 's'}
                      {collection.description ? ` · ${collection.description}` : ''}
                    </p>
                  </div>
                  <div className="mcp-strip__row-actions">
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      onClick={() => void handleRename(collection)}
                    >
                      Rename
                      <span className="sr-only"> {collection.name}</span>
                    </Button>
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      title={collection.isPublished ? 'Unpublish collection' : 'Publish collection'}
                      onClick={() => void handleTogglePublish(collection)}
                    >
                      <Globe aria-hidden />
                      <span className="sr-only">
                        {collection.isPublished ? 'Unpublish' : 'Publish'} {collection.name}
                      </span>
                    </Button>
                    {collection.isPublished && tenantSlug ? (
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        title="Copy public share link"
                        onClick={() => void handleCopyShareLink(collection)}
                      >
                        <Copy aria-hidden />
                        <span className="sr-only">Copy share link for {collection.name}</span>
                      </Button>
                    ) : null}
                    {tenantSlug ? (
                      <Button asChild variant="ghost" size="sm">
                        <Link
                          href={mcpCollectionPublicUrl(tenantSlug, collection.slug)}
                          target="_blank"
                          rel="noreferrer"
                        >
                          View
                          <span className="sr-only"> {collection.name}</span>
                          <ArrowUpRight aria-hidden />
                        </Link>
                      </Button>
                    ) : null}
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      className="mcp-strip__danger"
                      title="Delete collection"
                      onClick={() => void handleDelete(collection)}
                    >
                      <Trash2 aria-hidden />
                      <span className="sr-only">Delete {collection.name}</span>
                    </Button>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </div>
      ) : null}

      <Dialog open={createOpen} onOpenChange={setCreateOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Create collection</DialogTitle>
            <DialogDescription>
              Group related MCP endpoints into a named list. You can publish it later for a
              shareable browse view that only shows public endpoints.
            </DialogDescription>
          </DialogHeader>
          <div className="mcp-dialog__body">
            <FormField label="Name" htmlFor="collection-name" required>
              <Input
                id="collection-name"
                value={createName}
                onChange={(e) => setCreateName(e.target.value)}
                placeholder="e.g. Approved geo tools"
                autoFocus
              />
            </FormField>
            <FormField label="Description" htmlFor="collection-description">
              <Input
                id="collection-description"
                value={createDescription}
                onChange={(e) => setCreateDescription(e.target.value)}
                placeholder="Short note for your team"
              />
            </FormField>
            <Alert variant="info" data-testid="mcp-collection-membership">
              <p>{mcpCollectionMembershipHint(visibleEndpoints)}</p>
              <p>{COLLECTIONS_FIXED_MEMBERSHIP_NOTE}</p>
            </Alert>
            <div className="mcp-dialog__check">
              <Checkbox
                id="collection-publish"
                checked={createPublished}
                onCheckedChange={(next) => setCreatePublished(next === true)}
              />
              <Label htmlFor="collection-publish">
                Publish immediately (public endpoints only on browse)
              </Label>
            </div>
          </div>
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={() => setCreateOpen(false)}>
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
    </Card>
  );
}
