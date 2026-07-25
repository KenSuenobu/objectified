'use client';

/**
 * Control Panel → Governance → Style Guides — GOV-2.1 (#4433)
 *
 * Tenant-admin surface for the GOV-EPIC-1 style-guide engine:
 *  - List view: name (default / built-in badges), rules on, assignments, updated.
 *  - Create / duplicate: optionally copying an existing guide's rules — including
 *    "Start from Recommended", which duplicates the read-only built-in guide.
 *  - Assign dialog: make a guide the tenant default or bind it to individual projects
 *    (writes `style_guide_assignments`; the next lint run resolves it per GOV-1.4).
 *
 * Mutations are tenant-admin only (the REST layer enforces this; the UI hides the
 * controls via `/api/access/permissions/me`). The built-in "Apiome Recommended" guide is
 * read-only: it can be duplicated and assigned, never edited or deleted.
 */

import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';
import Link from 'next/link';
import {
  AlertCircle,
  BadgeCheck,
  BookOpenCheck,
  Copy,
  Pencil,
  Plus,
  RefreshCw,
  Sparkles,
  Trash2,
  X,
} from 'lucide-react';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/app/components/ui/Dialog';
import { useDialog } from '@/app/components/providers/DialogProvider';
import QualityPolicyPanel from './QualityPolicyPanel';
import {
  fetchMyPermissions,
  styleGuidesApi,
  type MyPermissions,
  type StyleGuide,
  type StyleGuideList,
} from './api';

interface ProjectOption {
  id: string;
  name: string;
}

/** Render an ISO timestamp as a short local date, or a dash when absent. */
function formatDate(iso: string | null): string {
  if (!iso) return '—';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '—';
  return date.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
}

const inputClasses =
  'w-full rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm text-gray-900 ' +
  'focus:outline-none focus:ring-2 focus:ring-indigo-500 dark:border-slate-700 dark:bg-slate-900 dark:text-white';

// ---------------------------------------------------------------------------
// Create / duplicate dialog
// ---------------------------------------------------------------------------

interface CreateDialogState {
  /** Guide whose rules the new guide copies; null starts empty. */
  sourceGuide: StyleGuide | null;
}

function CreateGuideDialog({
  state,
  guides,
  busy,
  onClose,
  onCreate,
}: {
  state: CreateDialogState | null;
  guides: StyleGuide[];
  busy: boolean;
  onClose: () => void;
  onCreate: (name: string, description: string, sourceGuideId: string | null) => void;
}) {
  // The parent remounts this dialog (via `key`) whenever it opens, so initializing from
  // props here prefills the duplicate flow without effect-driven state sync.
  const [name, setName] = useState(state?.sourceGuide ? `${state.sourceGuide.name} (copy)` : '');
  const [description, setDescription] = useState(state?.sourceGuide?.description || '');
  const [sourceId, setSourceId] = useState<string>(state?.sourceGuide?.id ?? '');

  const isDuplicate = !!state?.sourceGuide;
  return (
    <Dialog open={!!state} onOpenChange={(open) => !open && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{isDuplicate ? 'Duplicate style guide' : 'New style guide'}</DialogTitle>
          <DialogDescription>
            {isDuplicate
              ? `Creates an editable copy of “${state?.sourceGuide?.name}” with the same rules.`
              : 'Create a custom style guide, empty or copying an existing guide’s rules.'}
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          <div>
            <label htmlFor="guide-name" className="mb-1 block text-sm font-medium text-gray-700 dark:text-gray-200">
              Name
            </label>
            <input
              id="guide-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="e.g. Payments API Guide"
              className={inputClasses}
            />
          </div>
          <div>
            <label htmlFor="guide-description" className="mb-1 block text-sm font-medium text-gray-700 dark:text-gray-200">
              Description <span className="font-normal text-gray-400">(optional)</span>
            </label>
            <textarea
              id="guide-description"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              rows={2}
              placeholder="What this guide enforces…"
              className={`${inputClasses} resize-none`}
            />
          </div>
          <div>
            <label htmlFor="guide-source" className="mb-1 block text-sm font-medium text-gray-700 dark:text-gray-200">
              Copy rules from
            </label>
            <select
              id="guide-source"
              value={sourceId}
              onChange={(e) => setSourceId(e.target.value)}
              className={inputClasses}
            >
              <option value="">Empty guide (no rules)</option>
              {guides.map((g) => (
                <option key={g.id} value={g.id}>
                  {g.name} ({g.enabledRuleCount} rules on)
                </option>
              ))}
            </select>
          </div>
        </div>
        <DialogFooter>
          <button
            type="button"
            onClick={onClose}
            className="rounded-lg border border-slate-200 px-4 py-2 text-sm text-gray-700 hover:bg-slate-100 dark:border-slate-700 dark:text-gray-200 dark:hover:bg-slate-800"
          >
            Cancel
          </button>
          <button
            type="button"
            disabled={busy || !name.trim()}
            onClick={() => onCreate(name.trim(), description.trim(), sourceId || null)}
            className="rounded-lg bg-indigo-600 px-4 py-2 text-sm font-medium text-white hover:bg-indigo-700 disabled:opacity-50"
          >
            Create guide
          </button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ---------------------------------------------------------------------------
// Edit (rename / description) dialog
// ---------------------------------------------------------------------------

function EditGuideDialog({
  guide,
  busy,
  onClose,
  onSave,
}: {
  guide: StyleGuide | null;
  busy: boolean;
  onClose: () => void;
  onSave: (guideId: string, name: string, description: string) => void;
}) {
  // Remounted by the parent (via `key`) per guide, so prop-derived initial state suffices.
  const [name, setName] = useState(guide?.name ?? '');
  const [description, setDescription] = useState(guide?.description || '');

  return (
    <Dialog open={!!guide} onOpenChange={(open) => !open && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Edit style guide</DialogTitle>
          <DialogDescription>Rename the guide or update its description.</DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          <div>
            <label htmlFor="edit-guide-name" className="mb-1 block text-sm font-medium text-gray-700 dark:text-gray-200">
              Name
            </label>
            <input
              id="edit-guide-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              className={inputClasses}
            />
          </div>
          <div>
            <label
              htmlFor="edit-guide-description"
              className="mb-1 block text-sm font-medium text-gray-700 dark:text-gray-200"
            >
              Description
            </label>
            <textarea
              id="edit-guide-description"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              rows={2}
              className={`${inputClasses} resize-none`}
            />
          </div>
        </div>
        <DialogFooter>
          <button
            type="button"
            onClick={onClose}
            className="rounded-lg border border-slate-200 px-4 py-2 text-sm text-gray-700 hover:bg-slate-100 dark:border-slate-700 dark:text-gray-200 dark:hover:bg-slate-800"
          >
            Cancel
          </button>
          <button
            type="button"
            disabled={busy || !name.trim() || !guide}
            onClick={() => guide && onSave(guide.id, name.trim(), description.trim())}
            className="rounded-lg bg-indigo-600 px-4 py-2 text-sm font-medium text-white hover:bg-indigo-700 disabled:opacity-50"
          >
            Save changes
          </button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ---------------------------------------------------------------------------
// Assign dialog — tenant default + per-project assignments
// ---------------------------------------------------------------------------

function AssignGuideDialog({
  guide,
  projects,
  busy,
  onClose,
  onMakeDefault,
  onAssignProject,
  onUnassignProject,
}: {
  guide: StyleGuide | null;
  projects: ProjectOption[];
  busy: boolean;
  onClose: () => void;
  onMakeDefault: (guideId: string) => void;
  onAssignProject: (guideId: string, projectId: string) => void;
  onUnassignProject: (projectId: string) => void;
}) {
  const [projectId, setProjectId] = useState('');

  // Projects not already assigned to this guide are offered in the picker; re-assigning a
  // project that points at another guide simply moves it (the REST layer replaces the row).
  const assignedIds = useMemo(
    () => new Set((guide?.projectAssignments ?? []).map((a) => a.projectId)),
    [guide],
  );
  const options = projects.filter((p) => !assignedIds.has(p.id));

  return (
    <Dialog open={!!guide} onOpenChange={(open) => !open && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Assign “{guide?.name}”</DialogTitle>
          <DialogDescription>
            Assignments take effect on the next lint run: a project-level assignment wins over the
            tenant default.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-5">
          <section>
            <h4 className="mb-1 text-sm font-semibold text-gray-900 dark:text-white">Tenant default</h4>
            <p className="mb-2 text-xs text-gray-500 dark:text-gray-400">
              Applies to every project without its own assignment.
            </p>
            {guide?.isDefault ? (
              <span className="inline-flex items-center gap-1.5 rounded-full bg-emerald-100 px-2.5 py-1 text-xs font-medium text-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-300">
                <BadgeCheck className="h-3.5 w-3.5" />
                This guide is the tenant default
              </span>
            ) : (
              <button
                type="button"
                disabled={busy || !guide}
                onClick={() => guide && onMakeDefault(guide.id)}
                className="rounded-lg border border-indigo-300 px-3 py-1.5 text-sm font-medium text-indigo-600 hover:bg-indigo-50 disabled:opacity-50 dark:border-indigo-700 dark:text-indigo-400 dark:hover:bg-indigo-900/20"
              >
                Make tenant default
              </button>
            )}
          </section>

          <section>
            <h4 className="mb-1 text-sm font-semibold text-gray-900 dark:text-white">Project assignments</h4>
            <p className="mb-2 text-xs text-gray-500 dark:text-gray-400">
              Pin this guide to individual projects, overriding the tenant default.
            </p>
            <div className="flex gap-2">
              <select
                aria-label="Project to assign"
                value={projectId}
                onChange={(e) => setProjectId(e.target.value)}
                className={inputClasses}
              >
                <option value="">Select a project…</option>
                {options.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                  </option>
                ))}
              </select>
              <button
                type="button"
                disabled={busy || !projectId || !guide}
                onClick={() => {
                  if (!guide) return;
                  onAssignProject(guide.id, projectId);
                  setProjectId('');
                }}
                className="shrink-0 rounded-lg bg-indigo-600 px-4 py-2 text-sm font-medium text-white hover:bg-indigo-700 disabled:opacity-50"
              >
                Assign
              </button>
            </div>
            {(guide?.projectAssignments?.length ?? 0) > 0 ? (
              <ul className="mt-3 space-y-1.5">
                {guide?.projectAssignments.map((a) => (
                  <li
                    key={a.projectId}
                    className="flex items-center justify-between rounded-lg border border-slate-200 px-3 py-1.5 text-sm dark:border-slate-700"
                  >
                    <span className="truncate text-gray-900 dark:text-white">{a.projectName}</span>
                    <button
                      type="button"
                      aria-label={`Unassign ${a.projectName}`}
                      disabled={busy}
                      onClick={() => onUnassignProject(a.projectId)}
                      className="ml-2 shrink-0 rounded-md p-1 text-gray-400 hover:bg-rose-50 hover:text-rose-600 disabled:opacity-50 dark:hover:bg-rose-900/20"
                    >
                      <X className="h-4 w-4" />
                    </button>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="mt-3 text-xs text-gray-400">No projects assigned to this guide.</p>
            )}
          </section>
        </div>
        <DialogFooter>
          <button
            type="button"
            onClick={onClose}
            className="rounded-lg border border-slate-200 px-4 py-2 text-sm text-gray-700 hover:bg-slate-100 dark:border-slate-700 dark:text-gray-200 dark:hover:bg-slate-800"
          >
            Done
          </button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ---------------------------------------------------------------------------
// Screen
// ---------------------------------------------------------------------------

export default function StyleGuidesClient() {
  const { confirm } = useDialog();

  const [guides, setGuides] = useState<StyleGuide[]>([]);
  const [projects, setProjects] = useState<ProjectOption[]>([]);
  const [perms, setPerms] = useState<MyPermissions | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const [createState, setCreateState] = useState<CreateDialogState | null>(null);
  const [editGuideId, setEditGuideId] = useState<string | null>(null);
  const [assignGuideId, setAssignGuideId] = useState<string | null>(null);

  const canMutate = !!perms?.is_admin;
  const recommendedGuide = guides.find((g) => g.source === 'builtin') || null;
  // Dialogs read the guide from the freshest list so in-dialog mutations show immediately.
  const editGuide = guides.find((g) => g.id === editGuideId) || null;
  const assignGuide = guides.find((g) => g.id === assignGuideId) || null;

  const loadData = useCallback(async () => {
    setError('');
    try {
      const [guideList, myPerms, projectsRes] = await Promise.all([
        styleGuidesApi<StyleGuideList>(''),
        fetchMyPermissions(),
        fetch('/api/projects')
          .then((r) => r.json())
          .catch(() => null),
      ]);
      setGuides(guideList?.guides ?? []);
      setPerms(myPerms);
      if (projectsRes?.success && Array.isArray(projectsRes.projects)) {
        setProjects(
          (projectsRes.projects as { id: string; name: string }[]).map((p) => ({
            id: p.id,
            name: p.name,
          })),
        );
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load style guides');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadData();
  }, [loadData]);

  /** Run a mutation, surface its error, and refresh the list. */
  const mutate = useCallback(
    async (action: () => Promise<unknown>) => {
      setBusy(true);
      setError('');
      try {
        await action();
        await loadData();
        return true;
      } catch (e) {
        setError(e instanceof Error ? e.message : 'Request failed');
        return false;
      } finally {
        setBusy(false);
      }
    },
    [loadData],
  );

  const handleCreate = async (name: string, description: string, sourceGuideId: string | null) => {
    const ok = await mutate(() =>
      styleGuidesApi<StyleGuide>('', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name,
          description: description || null,
          sourceGuideId: sourceGuideId || null,
        }),
      }),
    );
    if (ok) setCreateState(null);
  };

  const handleSaveEdit = async (guideId: string, name: string, description: string) => {
    const ok = await mutate(() =>
      styleGuidesApi<StyleGuide>(guideId, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, description }),
      }),
    );
    if (ok) setEditGuideId(null);
  };

  const handleDelete = async (guide: StyleGuide) => {
    const confirmed = await confirm({
      title: 'Delete style guide',
      message:
        `Delete “${guide.name}”? Its project assignments are removed and those projects fall ` +
        'back to the tenant default. This cannot be undone.',
      confirmLabel: 'Delete',
    });
    if (!confirmed) return;
    await mutate(() => styleGuidesApi(guide.id, { method: 'DELETE' }));
  };

  const handleMakeDefault = (guideId: string) =>
    mutate(() => styleGuidesApi(`${guideId}/default`, { method: 'PUT' }));

  const handleAssignProject = (guideId: string, projectId: string) =>
    mutate(() => styleGuidesApi(`${guideId}/assignments/projects/${projectId}`, { method: 'PUT' }));

  const handleUnassignProject = (projectId: string) =>
    mutate(() => styleGuidesApi(`assignments/projects/${projectId}`, { method: 'DELETE' }));

  /** The list view's Assignments column: default badge + assigned-project chips. */
  const assignmentSummary = (guide: StyleGuide) => {
    const chips: ReactNode[] = [];
    if (guide.isDefault) {
      chips.push(
        <span
          key="default"
          className="inline-flex items-center gap-1 rounded-full bg-emerald-100 px-2 py-0.5 text-[11px] font-medium text-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-300"
        >
          <BadgeCheck className="h-3 w-3" />
          Tenant default
        </span>,
      );
    }
    for (const a of guide.projectAssignments) {
      chips.push(
        <span
          key={a.projectId}
          className="inline-flex items-center rounded-full bg-indigo-100 px-2 py-0.5 text-[11px] font-medium text-indigo-700 dark:bg-indigo-900/40 dark:text-indigo-300"
        >
          {a.projectName}
        </span>,
      );
    }
    if (chips.length === 0) {
      return <span className="text-xs text-gray-400">—</span>;
    }
    return <div className="flex flex-wrap gap-1">{chips}</div>;
  };

  return (
    <>
      <header className="border-b border-slate-200 bg-white dark:border-slate-800 dark:bg-slate-900">
        <div className="flex items-center justify-between gap-4 px-6 py-4">
          <div className="flex items-center gap-3">
            <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-indigo-600">
              <BookOpenCheck className="h-5 w-5 text-white" />
            </div>
            <div>
              <h2 className="text-2xl font-bold text-gray-900 dark:text-white">Style Guides</h2>
              <p className="mt-1 text-sm text-gray-500 dark:text-gray-400">
                Governance rules your specs are scored against
              </p>
            </div>
          </div>
          {canMutate && (
            <div className="flex shrink-0 gap-2">
              <button
                type="button"
                onClick={() => setCreateState({ sourceGuide: recommendedGuide })}
                disabled={busy || !recommendedGuide}
                className="flex items-center gap-2 rounded-lg border border-indigo-300 px-4 py-2 text-sm font-medium text-indigo-600 transition-colors hover:bg-indigo-50 disabled:opacity-50 dark:border-indigo-700 dark:text-indigo-400 dark:hover:bg-indigo-900/20"
              >
                <Sparkles className="h-4 w-4" />
                Start from Recommended
              </button>
              <button
                type="button"
                onClick={() => setCreateState({ sourceGuide: null })}
                disabled={busy}
                className="flex items-center gap-2 rounded-lg bg-indigo-600 px-4 py-2 text-sm text-white transition-colors hover:bg-indigo-700 disabled:opacity-50"
              >
                <Plus className="h-4 w-4" />
                New guide
              </button>
            </div>
          )}
        </div>
      </header>

      <main className="min-h-0 flex-1 overflow-y-auto bg-slate-50 p-6 dark:bg-slate-950">
        {error && (
          <div className="mb-6 flex items-start gap-3 rounded-lg border border-rose-300 bg-rose-50 p-4 text-rose-700 dark:border-rose-800 dark:bg-rose-900/20 dark:text-rose-300">
            <AlertCircle className="mt-0.5 h-5 w-5 flex-shrink-0" />
            <p className="text-sm">{error}</p>
          </div>
        )}

        {loading ? (
          <div className="flex items-center justify-center py-12">
            <RefreshCw className="h-8 w-8 animate-spin text-gray-400" />
          </div>
        ) : guides.length === 0 ? (
          <div className="rounded-xl border border-slate-200 bg-white p-12 text-center dark:border-slate-800 dark:bg-slate-900">
            <BookOpenCheck className="mx-auto mb-4 h-12 w-12 text-gray-400" />
            <p className="text-sm text-gray-500 dark:text-gray-400">No style guides yet.</p>
          </div>
        ) : (
          <div className="overflow-hidden rounded-xl border border-slate-200 bg-white dark:border-slate-800 dark:bg-slate-900">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-slate-200 text-left text-[11px] uppercase tracking-wider text-gray-400 dark:border-slate-800">
                  <th className="px-4 py-3 font-semibold">Name</th>
                  <th className="px-4 py-3 font-semibold">Rules on</th>
                  <th className="px-4 py-3 font-semibold">Assignments</th>
                  <th className="px-4 py-3 font-semibold">Updated</th>
                  {canMutate && <th className="px-4 py-3 text-right font-semibold">Actions</th>}
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
                {guides.map((guide) => (
                  <tr key={guide.id}>
                    <td className="px-4 py-3">
                      <div className="flex items-center gap-2">
                        <Link
                          href={`/ade/dashboard/style-guides/${guide.id}`}
                          className="font-medium text-gray-900 hover:text-indigo-600 hover:underline dark:text-white dark:hover:text-indigo-400"
                        >
                          {guide.name}
                        </Link>
                        {guide.source === 'builtin' && (
                          <span className="rounded-full bg-slate-100 px-2 py-0.5 text-[10px] font-medium text-slate-600 dark:bg-slate-800 dark:text-slate-300">
                            Built-in
                          </span>
                        )}
                        {guide.isDefault && (
                          <span className="inline-flex items-center gap-1 rounded-full bg-emerald-100 px-2 py-0.5 text-[10px] font-medium text-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-300">
                            <BadgeCheck className="h-3 w-3" />
                            Default
                          </span>
                        )}
                      </div>
                      {guide.description && (
                        <p className="mt-0.5 max-w-md truncate text-xs text-gray-500 dark:text-gray-400">
                          {guide.description}
                        </p>
                      )}
                    </td>
                    <td className="px-4 py-3 text-gray-700 dark:text-gray-300">
                      <span className="font-mono">{guide.enabledRuleCount}</span>
                      <span className="text-gray-400"> / {guide.ruleCount}</span>
                    </td>
                    <td className="px-4 py-3">{assignmentSummary(guide)}</td>
                    <td className="px-4 py-3 text-gray-500 dark:text-gray-400">{formatDate(guide.updatedAt)}</td>
                    {canMutate && (
                      <td className="px-4 py-3">
                        <div className="flex justify-end gap-1.5">
                          <button
                            type="button"
                            onClick={() => setAssignGuideId(guide.id)}
                            disabled={busy}
                            className="rounded-lg border border-slate-200 px-2.5 py-1.5 text-xs text-gray-700 hover:bg-slate-100 disabled:opacity-50 dark:border-slate-700 dark:text-gray-200 dark:hover:bg-slate-800"
                          >
                            Assign…
                          </button>
                          <button
                            type="button"
                            aria-label={`Duplicate ${guide.name}`}
                            title="Duplicate"
                            onClick={() => setCreateState({ sourceGuide: guide })}
                            disabled={busy}
                            className="rounded-lg border border-slate-200 p-1.5 text-gray-500 hover:bg-slate-100 disabled:opacity-50 dark:border-slate-700 dark:text-gray-400 dark:hover:bg-slate-800"
                          >
                            <Copy className="h-3.5 w-3.5" />
                          </button>
                          {guide.source !== 'builtin' && (
                            <>
                              <button
                                type="button"
                                aria-label={`Edit ${guide.name}`}
                                title="Edit"
                                onClick={() => setEditGuideId(guide.id)}
                                disabled={busy}
                                className="rounded-lg border border-slate-200 p-1.5 text-gray-500 hover:bg-slate-100 disabled:opacity-50 dark:border-slate-700 dark:text-gray-400 dark:hover:bg-slate-800"
                              >
                                <Pencil className="h-3.5 w-3.5" />
                              </button>
                              <button
                                type="button"
                                aria-label={`Delete ${guide.name}`}
                                title="Delete"
                                onClick={() => handleDelete(guide)}
                                disabled={busy}
                                className="rounded-lg border border-rose-200 p-1.5 text-rose-500 hover:bg-rose-50 disabled:opacity-50 dark:border-rose-900 dark:text-rose-400 dark:hover:bg-rose-900/20"
                              >
                                <Trash2 className="h-3.5 w-3.5" />
                              </button>
                            </>
                          )}
                        </div>
                      </td>
                    )}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        <p className="mt-3 text-[11px] text-gray-400">
          The built-in “Apiome Recommended” guide is read-only — duplicate it to customize. Open a
          guide to tailor its rule catalog; custom rules arrive with GOV-2.3.
        </p>

        {/* A guide decides how a document is scored; the quality policy decides what score is
            good enough to import or export it (IXH-2.3). Non-admins see it read-only, because a
            user who cannot see the policy cannot understand why a commit was refused. */}
        <div className="mt-8">
          <QualityPolicyPanel readOnly={!canMutate} />
        </div>
      </main>

      {/* `key` remounts each dialog when it opens (or targets a new guide), resetting its
          form state from props — see the useState initializers in the dialog components. */}
      <CreateGuideDialog
        key={createState ? `create-${createState.sourceGuide?.id ?? 'new'}` : 'create-closed'}
        state={createState}
        guides={guides}
        busy={busy}
        onClose={() => setCreateState(null)}
        onCreate={handleCreate}
      />
      <EditGuideDialog
        key={editGuideId ?? 'edit-closed'}
        guide={editGuide}
        busy={busy}
        onClose={() => setEditGuideId(null)}
        onSave={handleSaveEdit}
      />
      <AssignGuideDialog
        key={assignGuideId ?? 'assign-closed'}
        guide={assignGuide}
        projects={projects}
        busy={busy}
        onClose={() => setAssignGuideId(null)}
        onMakeDefault={handleMakeDefault}
        onAssignProject={handleAssignProject}
        onUnassignProject={handleUnassignProject}
      />
    </>
  );
}
