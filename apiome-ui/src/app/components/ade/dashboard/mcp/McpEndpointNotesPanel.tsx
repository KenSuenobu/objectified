'use client';

/**
 * Cataloger commentary — the human notes on an MCP endpoint (MCAT-18.x; re-skinned by
 * HIVE-7.8, #5325).
 *
 * Authority: `docs/mockups/sources/mcp-endpoint.html`'s `card--honey` commentary block, and
 * DESIGN.md §2, which reserves honey for brand moments and forbids it as a warning.
 *
 * Everything else on this screen was reported by an MCP server. This is the one panel a *person*
 * wrote, and the wash is what says so — which is why honey is spent here and nowhere else on the
 * route. It was fourteen amber palette classes before (`border-amber-200 bg-amber-50/80 …
 * dark:bg-amber-950/30`, `text-amber-950`, `text-amber-800/90`, `text-amber-900/70`), which froze
 * the panel on one light palette and one dark one and, at `--warn`'s hue, read as a warning in
 * every theme in between. It is `ui/Card`'s `honey` variant now: the same brand gradient the
 * first-run checklist and the onboarding tips use.
 *
 * The CRUD contract is unchanged — list, create, edit in place, delete, each through
 * `/api/mcp/endpoints/{id}/notes` and each announcing itself with a toast.
 */

import * as React from 'react';
import { Loader2, Pencil, Plus, StickyNote, Trash2, X } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '../../../ui/Button';
import { Card } from '../../../ui/Card';
import { Textarea } from '../../../ui/Textarea';
import {
  mcpEndpointNoteAuthorLabel,
  mcpEndpointNoteWasEdited,
  mcpEndpointNotesFromPayload,
  type McpEndpointNote,
} from './mcpEndpointNotesUi';

export interface McpEndpointNotesPanelProps {
  endpointId: string;
}

/** The panel's one-line explanation of what these notes are — pinned by the redesign suite. */
export const MCP_NOTES_SUBTITLE =
  'Human notes from your team — not reported by the MCP server.';

/** What an endpoint with no commentary yet says. */
export const MCP_NOTES_EMPTY =
  'No cataloger notes yet. Add context, caveats, or recommendations for your team.';

function notesUrl(endpointId: string, noteId?: string): string {
  const base = `/api/mcp/endpoints/${encodeURIComponent(endpointId)}/notes`;
  return noteId ? `${base}/${encodeURIComponent(noteId)}` : base;
}

async function fetchNotes(endpointId: string): Promise<McpEndpointNote[]> {
  const res = await fetch(notesUrl(endpointId), { credentials: 'include', cache: 'no-store' });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(typeof data.error === 'string' ? data.error : res.statusText);
  }
  return mcpEndpointNotesFromPayload(data);
}

function formatTimestamp(value: string): string {
  if (!value) return '—';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString();
}

/**
 * Cataloger notes on an endpoint — human commentary kept visually distinct from discovered data.
 *
 * @param props.endpointId Which endpoint's notes to read and write.
 * @returns The honey commentary card.
 */
export function McpEndpointNotesPanel({
  endpointId,
}: McpEndpointNotesPanelProps): React.ReactElement {
  const [notes, setNotes] = React.useState<McpEndpointNote[]>([]);
  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState<string | null>(null);
  const [draft, setDraft] = React.useState('');
  const [saving, setSaving] = React.useState(false);
  const [editingId, setEditingId] = React.useState<string | null>(null);
  const [editDraft, setEditDraft] = React.useState('');
  /** Whether the add-note composer is open. Collapsed by default so the panel leads with notes. */
  const [composing, setComposing] = React.useState(false);
  /** The heading's id, so the card can be a region labelled by the words a reader sees. */
  const headingId = React.useId();

  const reload = React.useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setNotes(await fetchNotes(endpointId));
    } catch (e) {
      setNotes([]);
      setError(e instanceof Error ? e.message : 'Could not load cataloger notes');
    } finally {
      setLoading(false);
    }
  }, [endpointId]);

  React.useEffect(() => {
    void reload();
  }, [reload]);

  const handleCreate = async () => {
    const body = draft.trim();
    if (!body) return;
    setSaving(true);
    setError(null);
    try {
      const res = await fetch(notesUrl(endpointId), {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ body }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        throw new Error(typeof data.error === 'string' ? data.error : res.statusText);
      }
      setDraft('');
      setComposing(false);
      toast.success('Cataloger note added');
      await reload();
    } catch (e) {
      const message = e instanceof Error ? e.message : 'Could not save note';
      setError(message);
      toast.error(message);
    } finally {
      setSaving(false);
    }
  };

  const cancelCompose = () => {
    setComposing(false);
    setDraft('');
    setError(null);
  };

  const startEdit = (note: McpEndpointNote) => {
    setEditingId(note.id);
    setEditDraft(note.body);
  };

  const cancelEdit = () => {
    setEditingId(null);
    setEditDraft('');
  };

  const handleUpdate = async (noteId: string) => {
    const body = editDraft.trim();
    if (!body) return;
    setSaving(true);
    setError(null);
    try {
      const res = await fetch(notesUrl(endpointId, noteId), {
        method: 'PATCH',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ body }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        throw new Error(typeof data.error === 'string' ? data.error : res.statusText);
      }
      cancelEdit();
      toast.success('Cataloger note updated');
      await reload();
    } catch (e) {
      const message = e instanceof Error ? e.message : 'Could not update note';
      setError(message);
      toast.error(message);
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async (noteId: string) => {
    setSaving(true);
    setError(null);
    try {
      const res = await fetch(notesUrl(endpointId, noteId), {
        method: 'DELETE',
        credentials: 'include',
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        throw new Error(typeof data.error === 'string' ? data.error : res.statusText);
      }
      toast.success('Cataloger note deleted');
      await reload();
    } catch (e) {
      const message = e instanceof Error ? e.message : 'Could not delete note';
      setError(message);
      toast.error(message);
    } finally {
      setSaving(false);
    }
  };

  return (
    <Card
      variant="honey"
      role="region"
      aria-labelledby={headingId}
      data-testid="mcp-endpoint-notes"
    >
      <div className="mcp-notes__head">
        <div className="mcp-notes__title">
          <StickyNote aria-hidden className="mcp-notes__glyph" />
          <div className="min-w-0">
            <h2 id={headingId} className="text-base font-semibold leading-snug text-fg">
              Cataloger commentary
            </h2>
            <p className="mt-0.5 text-xs text-fg-muted">{MCP_NOTES_SUBTITLE}</p>
          </div>
        </div>
        {!composing ? (
          <Button
            type="button"
            size="sm"
            variant="outline"
            className="shrink-0"
            onClick={() => setComposing(true)}
            data-testid="mcp-endpoint-note-add"
          >
            <Plus aria-hidden />
            Add note
          </Button>
        ) : null}
      </div>

      <div className="mcp-notes__body">
        {loading ? (
          <p className="flex items-center gap-2 text-sm text-fg-muted" role="status">
            <Loader2 className="size-4 animate-spin" aria-hidden />
            Loading notes…
          </p>
        ) : null}

        {error ? (
          <p className="rounded-md bg-danger-soft px-3 py-2 text-sm text-danger-fg" role="alert">
            {error}
          </p>
        ) : null}

        {!loading && notes.length === 0 ? (
          <p className="text-sm text-fg-muted">{MCP_NOTES_EMPTY}</p>
        ) : null}

        {notes.map((note) => (
          <article key={note.id} className="mcp-note" data-testid={`mcp-endpoint-note-${note.id}`}>
            {editingId === note.id ? (
              <div className="flex flex-col gap-3">
                <Textarea
                  value={editDraft}
                  onChange={(e) => setEditDraft(e.target.value)}
                  rows={4}
                  aria-label="Edit cataloger note"
                />
                <div className="flex flex-wrap gap-2">
                  <Button
                    type="button"
                    size="sm"
                    disabled={saving || !editDraft.trim()}
                    onClick={() => void handleUpdate(note.id)}
                  >
                    {saving ? <Loader2 className="animate-spin" aria-hidden /> : null}
                    Save
                  </Button>
                  <Button type="button" size="sm" variant="outline" onClick={cancelEdit}>
                    <X aria-hidden />
                    Cancel
                  </Button>
                </div>
              </div>
            ) : (
              <>
                <p className="mcp-note__text">{note.body}</p>
                <div className="mcp-note__foot">
                  <span>
                    <span className="font-medium text-fg">{mcpEndpointNoteAuthorLabel(note)}</span>
                    <span className="mx-1" aria-hidden>
                      ·
                    </span>
                    <time dateTime={note.createdAt}>{formatTimestamp(note.createdAt)}</time>
                    {mcpEndpointNoteWasEdited(note) ? <em className="ml-1">(edited)</em> : null}
                  </span>
                  <span className="mcp-note__actions">
                    <Button
                      type="button"
                      size="sm"
                      variant="ghost"
                      disabled={saving}
                      onClick={() => startEdit(note)}
                      title="Edit note"
                      aria-label="Edit note"
                    >
                      <Pencil aria-hidden />
                    </Button>
                    <Button
                      type="button"
                      size="sm"
                      variant="ghost"
                      disabled={saving}
                      onClick={() => void handleDelete(note.id)}
                      title="Delete note"
                      aria-label="Delete note"
                    >
                      {/* The glyph is emphasis; the button's accessible name is the message. */}
                      <Trash2 aria-hidden className="text-danger" />
                    </Button>
                  </span>
                </div>
              </>
            )}
          </article>
        ))}

        {composing ? (
          <div className="mcp-note">
            <label
              htmlFor={`cataloger-note-draft-${endpointId}`}
              className="mb-1.5 block text-2xs font-semibold uppercase tracking-[var(--track-caps)] text-fg-muted"
            >
              Add a note
            </label>
            <Textarea
              id={`cataloger-note-draft-${endpointId}`}
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              rows={3}
              autoFocus
              placeholder="e.g. Prefer the staging endpoint for QA — production is read-only."
            />
            <div className="mcp-note__form-actions">
              <Button
                type="button"
                size="sm"
                variant="outline"
                disabled={saving}
                onClick={cancelCompose}
              >
                <X aria-hidden />
                Cancel
              </Button>
              <Button
                type="button"
                size="sm"
                disabled={saving || !draft.trim()}
                onClick={() => void handleCreate()}
              >
                {saving ? <Loader2 className="animate-spin" aria-hidden /> : null}
                Save note
              </Button>
            </div>
          </div>
        ) : null}
      </div>
    </Card>
  );
}
