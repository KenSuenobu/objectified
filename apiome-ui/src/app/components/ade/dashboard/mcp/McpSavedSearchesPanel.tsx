'use client';

/**
 * Saved catalog searches (V2-MCP-35.3 / MCAT-21.3; redesigned HIVE-7.7, #5324).
 *
 * Authority: `docs/mockups/sources/mcp-servers.html` — the left half of the strips row, whose
 * **Notes → Keeps (1:1)** list fixes the contract: pinned honey pills, a *Save search* button, a
 * `Saved (n)` disclosure, a manage list with Run / Pin-Unpin / Delete per row, and a
 * *Save catalog search* dialog with a required name and *Pin as catalog view*. Server-persisted.
 *
 * ### The contract this keeps
 *
 * A saved search stores **the view, not the result**: the query, the ten facets and the sort as
 * they were when it was saved. Running it puts those controls back and the catalog is re-filtered
 * from whatever is in it now — so a saved view picks up an endpoint registered yesterday, which
 * is the whole reason to save one. The row prints exactly what will be restored
 * ({@link mcpCatalogViewSummary}), and the dialog prints the same line before it is saved, so
 * "what did I save?" is never a question a reader has to answer by running it.
 *
 * ### What the redesign changed
 *
 * 1. **The strip had no panel of its own.** It was a bare row the page wrapped in a
 *    `border-b border-gray-200 bg-white` band. It is a `ui/Card` with a titled header row, as the
 *    mockup draws it, so the saved views and the collections beside them are two matching panels.
 * 2. **The pinned pills were six amber palette classes.** They are `Button variant="honey"`
 *    pills — honey is DESIGN.md §2's "marked by a person" ornament, which is what a pin is, and
 *    `ui/statusVocabulary` already answers `pinned` with it.
 * 3. **A row said only its name and its raw query.** It now prints the whole view, filters
 *    included, so a list of five saved searches is readable without running any of them.
 * 4. **The dialog was hand-built** out of a bare `<label>`, an `<input type="checkbox">` with a
 *    `rounded border-gray-300`, and no summary. It is `FormField` + `Checkbox`, and it shows the
 *    view it is about to save.
 * 5. **Errors were a red sentence** (`text-red-600 dark:text-red-400`). They are `ui/Alert`.
 */

import * as React from 'react';
import { Bookmark, Pin, PinOff, Play, Trash2 } from 'lucide-react';
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
import {
  mcpApplySavedSearch,
  mcpPinnedSavedSearches,
  mcpSavedSearchCreateBody,
  mcpSavedSearchesFromPayload,
  type McpSavedSearch,
} from './mcpSavedSearchUi';
import {
  mcpCatalogViewSummary,
  type McpCatalogFilters,
  type McpCatalogSortKey,
} from './mcpCatalogUi';

export interface McpSavedSearchesPanelProps {
  filters: McpCatalogFilters;
  query: string;
  sort: McpCatalogSortKey;
  onApply: (next: { filters: McpCatalogFilters; query: string; sort: McpCatalogSortKey }) => void;
}

/** What the panel says while it is reading, and when it has nothing to show. */
export const SAVED_SEARCHES_LOADING = 'Loading saved searches…';
export const SAVED_SEARCHES_EMPTY =
  'No saved searches yet. Set your filters and choose Save search.';

async function fetchSavedSearches(): Promise<McpSavedSearch[]> {
  const res = await fetch('/api/mcp/saved-searches', { credentials: 'include' });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(typeof data.error === 'string' ? data.error : res.statusText);
  }
  return mcpSavedSearchesFromPayload(data);
}

export function McpSavedSearchesPanel({
  filters,
  query,
  sort,
  onApply,
}: McpSavedSearchesPanelProps): React.ReactElement {
  const [searches, setSearches] = React.useState<McpSavedSearch[]>([]);
  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState<string | null>(null);
  const [panelOpen, setPanelOpen] = React.useState(false);
  const [saveOpen, setSaveOpen] = React.useState(false);
  const [saveName, setSaveName] = React.useState('');
  const [savePinned, setSavePinned] = React.useState(false);
  const [saving, setSaving] = React.useState(false);

  const reload = React.useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setSearches(await fetchSavedSearches());
    } catch (e) {
      setSearches([]);
      setError(e instanceof Error ? e.message : 'Could not load saved searches');
    } finally {
      setLoading(false);
    }
  }, []);

  React.useEffect(() => {
    void reload();
  }, [reload]);

  const pinned = React.useMemo(() => mcpPinnedSavedSearches(searches), [searches]);

  /** The view the dialog is about to save, in the same words a saved row prints. */
  const pendingSummary = mcpCatalogViewSummary(query, filters, sort);

  const handleSave = async () => {
    const name = saveName.trim();
    if (!name) return;
    setSaving(true);
    setError(null);
    try {
      const res = await fetch('/api/mcp/saved-searches', {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(mcpSavedSearchCreateBody(name, filters, query, sort, savePinned)),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        throw new Error(typeof data.error === 'string' ? data.error : res.statusText);
      }
      setSaveOpen(false);
      setSaveName('');
      setSavePinned(false);
      await reload();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not save search');
    } finally {
      setSaving(false);
    }
  };

  const handleRun = (search: McpSavedSearch) => {
    onApply(mcpApplySavedSearch(search));
    setPanelOpen(false);
  };

  const handleDelete = async (searchId: string) => {
    setError(null);
    try {
      const res = await fetch(`/api/mcp/saved-searches/${encodeURIComponent(searchId)}`, {
        method: 'DELETE',
        credentials: 'include',
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        throw new Error(typeof data.error === 'string' ? data.error : res.statusText);
      }
      await reload();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not delete saved search');
    }
  };

  const handleTogglePin = async (search: McpSavedSearch) => {
    setError(null);
    try {
      const res = await fetch(`/api/mcp/saved-searches/${encodeURIComponent(search.id)}`, {
        method: 'PATCH',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ isPinned: !search.isPinned }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        throw new Error(typeof data.error === 'string' ? data.error : res.statusText);
      }
      await reload();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not update saved search');
    }
  };

  return (
    <Card className="mcp-strip" data-testid="mcp-saved-searches">
      <div className="mcp-strip__head">
        <div className="mcp-strip__lead">
          <p className="mcp-strip__label">Saved searches</p>
          {pinned.map((search) => (
            <Button
              key={search.id}
              type="button"
              variant="honey"
              size="sm"
              pill
              onClick={() => handleRun(search)}
              title={`Run saved view: ${search.name}`}
            >
              <Pin aria-hidden />
              {search.name}
            </Button>
          ))}
        </div>
        <div className="mcp-strip__actions">
          <Button type="button" variant="outline" size="sm" onClick={() => setSaveOpen(true)}>
            <Bookmark aria-hidden />
            Save search
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            aria-expanded={panelOpen}
            onClick={() => setPanelOpen((v) => !v)}
          >
            Saved ({searches.length})
          </Button>
        </div>
      </div>

      {panelOpen ? (
        <div className="mcp-strip__body">
          {error ? <Alert variant="danger">{error}</Alert> : null}
          {loading ? (
            <p className="mcp-strip__note">{SAVED_SEARCHES_LOADING}</p>
          ) : searches.length === 0 ? (
            <p className="mcp-strip__note">{SAVED_SEARCHES_EMPTY}</p>
          ) : (
            <ul className="mcp-strip__list">
              {searches.map((search) => (
                <li key={search.id} className="mcp-strip__row">
                  <div className="mcp-strip__row-main">
                    <div className="mcp-strip__row-title">
                      {search.name}
                      {search.isPinned ? <Badge status="pinned">pinned</Badge> : null}
                    </div>
                    <p className="mcp-strip__row-sub">
                      {mcpCatalogViewSummary(search.query, search.filters, search.sort)}
                    </p>
                  </div>
                  <div className="mcp-strip__row-actions">
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      title="Run saved search"
                      onClick={() => handleRun(search)}
                    >
                      <Play aria-hidden />
                      <span className="sr-only">Run {search.name}</span>
                    </Button>
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      title={search.isPinned ? 'Unpin view' : 'Pin as catalog view'}
                      onClick={() => void handleTogglePin(search)}
                    >
                      {search.isPinned ? <PinOff aria-hidden /> : <Pin aria-hidden />}
                      <span className="sr-only">
                        {search.isPinned ? 'Unpin' : 'Pin'} {search.name}
                      </span>
                    </Button>
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      className="mcp-strip__danger"
                      title="Delete saved search"
                      onClick={() => void handleDelete(search.id)}
                    >
                      <Trash2 aria-hidden />
                      <span className="sr-only">Delete {search.name}</span>
                    </Button>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </div>
      ) : null}

      <Dialog open={saveOpen} onOpenChange={setSaveOpen}>
        <DialogContent size="sm">
          <DialogHeader>
            <DialogTitle>Save catalog search</DialogTitle>
            <DialogDescription>
              Save the current filters, search text, and sort so you can re-run them later.
            </DialogDescription>
          </DialogHeader>
          <div className="mcp-dialog__body">
            <FormField label="Name" htmlFor="saved-search-name" required>
              <Input
                id="saved-search-name"
                value={saveName}
                onChange={(e) => setSaveName(e.target.value)}
                placeholder="e.g. Ungraded destructive servers"
                autoFocus
              />
            </FormField>
            <Card variant="soft" className="mcp-dialog__summary" data-testid="mcp-save-summary">
              Saves: {pendingSummary}
            </Card>
            <div className="mcp-dialog__check">
              <Checkbox
                id="saved-search-pin"
                checked={savePinned}
                onCheckedChange={(next) => setSavePinned(next === true)}
              />
              <Label htmlFor="saved-search-pin">Pin as catalog view</Label>
            </div>
          </div>
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={() => setSaveOpen(false)}>
              Cancel
            </Button>
            <Button
              type="button"
              disabled={!saveName.trim() || saving}
              onClick={() => void handleSave()}
            >
              Save
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Card>
  );
}
