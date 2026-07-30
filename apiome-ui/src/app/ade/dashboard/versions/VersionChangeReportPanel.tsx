'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { Markdown, MARKDOWN_EMPTY_EM_DASH } from '@/app/components/ui/Markdown';
import { githubMarkdownComponents } from '@/app/components/ui/markdownGithubComponents';
import Mustache from 'mustache';
import { FileText, Loader2, RefreshCw, Settings2 } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/app/components/ui/Button';
import { Label } from '@/app/components/ui/Label';
import { Textarea } from '@/app/components/ui/Textarea';
import { Input } from '@/app/components/ui/Input';
import { Alert } from '@/app/components/ui/Alert';
import { EmptyState } from '@/app/components/ui/EmptyState';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/app/components/ui/Select';
import { Checkbox } from '@/app/components/ui/Checkbox';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/app/components/ui/Dialog';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/app/components/ui/Tabs';
import { buildMustacheContext } from '@lib/change-report-mustache-context';
import sampleFixture from '@lib/change-report-sample-fixture.json';
import { dashboardPanelClass } from '@/app/components/ade/dashboard/dashboardScreenClasses';

export type VersionChangeReportVersionRow = {
  id: string;
  project_id: string;
  creator_id: string;
  version_id: string;
  published: boolean;
  shortMessage: string | null;
};

export type VersionChangeReportPanelProps = {
  projectId: string;
  versions: VersionChangeReportVersionRow[];
  currentUserId: string | undefined;
  effectiveIsAdmin: boolean;
};

type VersionChangeReportOut = {
  effectiveHeaderSnapshot?: string | null;
  effectiveRenderedBody?: string | null;
  effectiveFootnoteSnapshot?: string | null;
  editedRenderedBody?: string | null;
  editedHeaderSnapshot?: string | null;
  editedFootnoteSnapshot?: string | null;
  changeModelJson?: Record<string, unknown>;
};

type TemplateSummary = {
  id: string;
  semver: string;
  ownerTenantId?: string | null;
};

/**
 * Renders change report snapshot text (header / body / footnote) using the
 * shared GitHub-flavored component map. `allowHtml` is on because the template
 * pipeline emits a mix of HTML and Markdown — without it, raw `<div>`/`<span>`
 * markup leaks through as visible text and the document looks unstyled.
 */
function SafeMarkdown({ content, className }: { content: string; className?: string }) {
  return (
    <Markdown
      variant="article"
      allowHtml
      components={githubMarkdownComponents}
      className={className}
      fallback={MARKDOWN_EMPTY_EM_DASH}
    >
      {content}
    </Markdown>
  );
}

export function VersionChangeReportPanel({
  projectId,
  versions,
  currentUserId,
  effectiveIsAdmin,
}: VersionChangeReportPanelProps) {
  const published = useMemo(
    () =>
      versions
        .filter((v) => v.published && v.project_id === projectId)
        .sort((a, b) => b.version_id.localeCompare(a.version_id, undefined, { numeric: true })),
    [versions, projectId],
  );

  const [revisionId, setRevisionId] = useState<string>('');
  useEffect(() => {
    if (published.length === 0) {
      setRevisionId('');
      return;
    }
    if (!revisionId || !published.some((p) => p.id === revisionId)) {
      setRevisionId(published[0].id);
    }
  }, [published, revisionId]);

  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [report, setReport] = useState<VersionChangeReportOut | null>(null);

  const selected = published.find((p) => p.id === revisionId);
  const canEdit =
    Boolean(currentUserId) &&
    selected &&
    (selected.creator_id === currentUserId || effectiveIsAdmin);

  const loadReport = useCallback(async () => {
    if (!revisionId || !projectId) return;
    setLoading(true);
    setError(null);
    try {
      const qs = new URLSearchParams({ projectId });
      const res = await fetch(`/api/versions/${encodeURIComponent(revisionId)}/change-report?${qs.toString()}`);
      const json = (await res.json()) as { success?: boolean; error?: string; report?: VersionChangeReportOut };
      if (!json.success || !json.report) {
        const msg = typeof json.error === 'string' ? json.error : 'Failed to load change report';
        setReport(null);
        setError(msg);
        return;
      }
      setReport(json.report);
      setError(null);
    } catch (e) {
      setReport(null);
      setError(e instanceof Error ? e.message : 'Failed to load change report');
    } finally {
      setLoading(false);
    }
  }, [revisionId, projectId]);

  useEffect(() => {
    void loadReport();
  }, [loadReport]);

  const [editHeader, setEditHeader] = useState('');
  const [editBody, setEditBody] = useState('');
  const [editFoot, setEditFoot] = useState('');
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!report) return;
    setEditHeader(report.effectiveHeaderSnapshot ?? '');
    setEditBody(report.effectiveRenderedBody ?? '');
    setEditFoot(report.effectiveFootnoteSnapshot ?? '');
  }, [report]);

  const handleSaveEdits = async () => {
    if (!revisionId || !projectId || !canEdit) return;
    setSaving(true);
    try {
      const qs = new URLSearchParams({ projectId });
      const res = await fetch(`/api/versions/${encodeURIComponent(revisionId)}/change-report?${qs.toString()}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          editedHeaderSnapshot: editHeader,
          editedRenderedBody: editBody,
          editedFootnoteSnapshot: editFoot,
        }),
      });
      const json = (await res.json()) as { success?: boolean; error?: string; report?: VersionChangeReportOut };
      if (!json.success || !json.report) {
        toast.error(typeof json.error === 'string' ? json.error : 'Save failed');
        return;
      }
      setReport(json.report);
      toast.success('Change report saved');
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Save failed');
    } finally {
      setSaving(false);
    }
  };

  const handleClearEdits = async () => {
    if (!revisionId || !projectId || !canEdit) return;
    setSaving(true);
    try {
      const qs = new URLSearchParams({ projectId });
      const res = await fetch(`/api/versions/${encodeURIComponent(revisionId)}/change-report?${qs.toString()}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ clearEdits: true }),
      });
      const json = (await res.json()) as { success?: boolean; error?: string; report?: VersionChangeReportOut };
      if (!json.success || !json.report) {
        toast.error(typeof json.error === 'string' ? json.error : 'Reset failed');
        return;
      }
      setReport(json.report);
      toast.success('Edits cleared; showing rendered snapshots');
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Reset failed');
    } finally {
      setSaving(false);
    }
  };

  const [templates, setTemplates] = useState<TemplateSummary[]>([]);
  const [regenTemplateId, setRegenTemplateId] = useState<string>('__effective__');
  const [discardEdits, setDiscardEdits] = useState(true);
  const [regenerating, setRegenerating] = useState(false);

  const loadTemplates = useCallback(async () => {
    try {
      const res = await fetch('/api/change-report-template-versions');
      const json = (await res.json()) as { success?: boolean; templates?: TemplateSummary[] };
      if (json.success && Array.isArray(json.templates)) {
        setTemplates(json.templates);
      }
    } catch {
      /* ignore */
    }
  }, []);

  useEffect(() => {
    void loadTemplates();
  }, [loadTemplates]);

  const handleRegenerate = async () => {
    if (!revisionId || !projectId || !canEdit) return;
    setRegenerating(true);
    try {
      const qs = new URLSearchParams({ projectId });
      const body: Record<string, unknown> = {
        discardUserEdits: discardEdits,
      };
      if (regenTemplateId && regenTemplateId !== '__effective__') {
        body.templateVersionId = regenTemplateId.trim();
      }
      const res = await fetch(
        `/api/versions/${encodeURIComponent(revisionId)}/change-report/regenerate?${qs.toString()}`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        },
      );
      const json = (await res.json()) as { success?: boolean; error?: string; report?: VersionChangeReportOut };
      if (!json.success || !json.report) {
        toast.error(typeof json.error === 'string' ? json.error : 'Regenerate failed');
        return;
      }
      setReport(json.report);
      toast.success('Change report regenerated');
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Regenerate failed');
    } finally {
      setRegenerating(false);
    }
  };

  const [templateDialogOpen, setTemplateDialogOpen] = useState(false);
  const [tplSemver, setTplSemver] = useState('1.0.1');
  const [tplHeader, setTplHeader] = useState('');
  const [tplBody, setTplBody] = useState('');
  const [tplFoot, setTplFoot] = useState('');
  const [tplCreating, setTplCreating] = useState(false);
  const [defaultPick, setDefaultPick] = useState<string>('');
  const previewBlocks = useMemo(() => {
    try {
      const ctx = buildMustacheContext(sampleFixture as Record<string, unknown>, {
        productName: 'Sample API',
        fromVersionLabel: '0.9.0',
        toVersionLabel: '1.0.0',
        publishTimestamp: new Date().toISOString(),
        staticFootnote: 'Preview fixture',
      });
      const h = Mustache.render(tplHeader || ' ', ctx).trim();
      const b = Mustache.render(tplBody || ' ', ctx).trim();
      const f = Mustache.render(tplFoot || ' ', ctx).trim();
      return { h, b, f, err: null as string | null };
    } catch (e) {
      const msg = e instanceof Error ? e.message : 'Preview failed';
      return { h: '', b: '', f: '', err: msg };
    }
  }, [tplHeader, tplBody, tplFoot]);

  const handleCreateTemplate = async () => {
    setTplCreating(true);
    try {
      const res = await fetch('/api/change-report-template-versions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          semver: tplSemver.trim(),
          headerTemplate: tplHeader,
          bodyTemplate: tplBody,
          footnoteTemplate: tplFoot,
        }),
      });
      const json = (await res.json()) as { success?: boolean; error?: string; template?: { id: string } };
      if (!json.success) {
        toast.error(typeof json.error === 'string' ? json.error : 'Create failed');
        return;
      }
      toast.success('Template version created');
      await loadTemplates();
      if (json.template?.id) {
        setDefaultPick(json.template.id);
      }
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Create failed');
    } finally {
      setTplCreating(false);
    }
  };

  const handleSetProjectDefault = async () => {
    if (!defaultPick.trim()) {
      toast.warning('Select a template');
      return;
    }
    try {
      const res = await fetch(`/api/projects/${encodeURIComponent(projectId)}/change-report-template-default`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ templateVersionId: defaultPick.trim() }),
      });
      const json = (await res.json()) as { success?: boolean; error?: string };
      if (!json.success) {
        toast.error(typeof json.error === 'string' ? json.error : 'Update failed');
        return;
      }
      toast.success('Project default template updated');
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Update failed');
    }
  };

  const handleSetTenantDefault = async () => {
    if (!effectiveIsAdmin) {
      toast.warning('Tenant administrators only');
      return;
    }
    if (!defaultPick.trim()) {
      toast.warning('Select a template');
      return;
    }
    try {
      const res = await fetch('/api/change-report-template-default', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ templateVersionId: defaultPick.trim() }),
      });
      const json = (await res.json()) as { success?: boolean; error?: string };
      if (!json.success) {
        toast.error(typeof json.error === 'string' ? json.error : 'Update failed');
        return;
      }
      toast.success('Tenant default template updated');
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Update failed');
    }
  };

  const handleClearProjectDefault = async () => {
    try {
      const res = await fetch(`/api/projects/${encodeURIComponent(projectId)}/change-report-template-default`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ templateVersionId: null }),
      });
      const json = (await res.json()) as { success?: boolean; error?: string };
      if (!json.success) {
        toast.error(typeof json.error === 'string' ? json.error : 'Update failed');
        return;
      }
      toast.success('Project template override cleared');
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Update failed');
    }
  };

  if (!projectId) {
    return (
      <EmptyState
        icon={<FileText className="h-10 w-10" />}
        title="Select a project"
        description="Choose a project to work with publication change reports."
        iconContainerClassName="from-slate-500 to-gray-600 shadow-slate-500/30"
      />
    );
  }

  if (published.length === 0) {
    return (
      <div data-testid="version-change-report-empty" className={`${dashboardPanelClass} p-6`}>
        <EmptyState
          icon={<FileText className="h-10 w-10" />}
          title="No published revisions"
          description="Publish a schema revision first. Change reports are generated when a version is published (CR-04)."
          iconContainerClassName="from-slate-500 to-gray-600 shadow-slate-500/30"
        />
      </div>
    );
  }

  const notFoundMsg =
    error &&
    (error.includes('No change report stored') || error.includes('404') || error.toLowerCase().includes('not found'));

  return (
    <div data-testid="version-change-report-panel" className="space-y-4">
      <div className={`${dashboardPanelClass} px-4 py-3 flex flex-wrap items-end gap-3`}>
        <div className="flex flex-col gap-1 min-w-[14rem] flex-1">
          <Label htmlFor="change-report-revision" className="text-xs text-gray-500 dark:text-gray-400">
            Published revision
          </Label>
          <Select value={revisionId} onValueChange={setRevisionId}>
            <SelectTrigger id="change-report-revision" data-testid="change-report-revision-select">
              <SelectValue placeholder="Choose revision" />
            </SelectTrigger>
            <SelectContent>
              {published.map((p) => (
                <SelectItem key={p.id} value={p.id}>
                  v{p.version_id}
                  {p.shortMessage ? ` — ${p.shortMessage}` : ''}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <Button
          type="button"
          variant="secondary"
          data-testid="change-report-refresh"
          onClick={() => void loadReport()}
          disabled={loading}
        >
          {loading ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : null}
          Refresh
        </Button>
        <Button
          type="button"
          variant="secondary"
          data-testid="change-report-template-dialog-open"
          onClick={() => setTemplateDialogOpen(true)}
        >
          <Settings2 className="h-4 w-4 mr-1.5" aria-hidden />
          Templates
        </Button>
      </div>

      {loading && !report ? (
        <div className="flex items-center gap-2 text-sm text-gray-600 dark:text-gray-400" role="status">
          <Loader2 className="h-4 w-4 animate-spin shrink-0" aria-hidden />
          Loading change report…
        </div>
      ) : null}

      {error && (
        <Alert variant={notFoundMsg ? 'info' : 'error'} data-testid="change-report-error">
          {notFoundMsg
            ? 'No change report is stored for this publication yet. It is created when the revision is published (if generation succeeded).'
            : error}
        </Alert>
      )}

      {report && (
        <div className={`${dashboardPanelClass} p-4 space-y-4`}>
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h2 className="text-base font-semibold text-gray-900 dark:text-white">Publication change report</h2>
            {canEdit ? (
              <div className="flex flex-wrap gap-2">
                <Button
                  type="button"
                  variant="secondary"
                  size="sm"
                  data-testid="change-report-regenerate"
                  onClick={() => void handleRegenerate()}
                  disabled={regenerating || saving}
                >
                  {regenerating ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : <RefreshCw className="h-4 w-4" aria-hidden />}
                  Regenerate
                </Button>
              </div>
            ) : null}
          </div>

          {canEdit ? (
            <div
              className="rounded-lg border border-gray-200 dark:border-gray-700 bg-gray-50/80 dark:bg-gray-900/40 px-3 py-2 space-y-2"
              data-testid="change-report-regenerate-options"
            >
              <p className="text-xs font-medium text-gray-700 dark:text-gray-300">Regenerate options</p>
              <div className="flex flex-col sm:flex-row sm:items-center gap-3">
                <div className="flex flex-col gap-1 min-w-[12rem] flex-1">
                  <Label className="text-xs text-gray-500 dark:text-gray-400">Template (optional)</Label>
                  <Select value={regenTemplateId} onValueChange={setRegenTemplateId}>
                    <SelectTrigger data-testid="change-report-regenerate-template">
                      <SelectValue placeholder="Effective default (project → tenant → system)" />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="__effective__">Effective default</SelectItem>
                      {templates.map((t) => (
                        <SelectItem key={t.id} value={t.id}>
                          {t.semver} ({t.id.slice(0, 8)}…)
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                <label className="flex items-center gap-2 text-sm text-gray-700 dark:text-gray-300 cursor-pointer">
                  <Checkbox
                    checked={discardEdits}
                    onCheckedChange={(v) => setDiscardEdits(v === true)}
                    data-testid="change-report-regenerate-discard-edits"
                  />
                  Discard user edits when regenerating
                </label>
              </div>
            </div>
          ) : null}

          <Tabs defaultValue="view" className="w-full">
            <TabsList aria-label="Change report view or edit">
              <TabsTrigger value="view" data-testid="change-report-tab-view">
                View
              </TabsTrigger>
              <TabsTrigger value="edit" disabled={!canEdit} data-testid="change-report-tab-edit">
                Edit
              </TabsTrigger>
            </TabsList>
            <TabsContent value="view" className="pt-4 space-y-6" data-testid="change-report-view">
              <section aria-labelledby="cr-h">
                <h3 id="cr-h" className="text-sm font-semibold text-gray-900 dark:text-white mb-2">
                  Header
                </h3>
                <SafeMarkdown content={report.effectiveHeaderSnapshot ?? ''} />
              </section>
              <section aria-labelledby="cr-b">
                <h3 id="cr-b" className="text-sm font-semibold text-gray-900 dark:text-white mb-2">
                  Body
                </h3>
                <SafeMarkdown content={report.effectiveRenderedBody ?? ''} />
              </section>
              <section aria-labelledby="cr-f">
                <h3 id="cr-f" className="text-sm font-semibold text-gray-900 dark:text-white mb-2">
                  Footnote
                </h3>
                <SafeMarkdown content={report.effectiveFootnoteSnapshot ?? ''} />
              </section>
            </TabsContent>
            <TabsContent value="edit" className="pt-4 space-y-3" data-testid="change-report-edit">
              <p className="text-xs text-gray-500 dark:text-gray-400">
                Edits replace the rendered snapshot for this publication. Use <strong>Clear overrides</strong> to restore
                server-rendered text.
              </p>
              <div className="space-y-2">
                <Label htmlFor="cr-edit-h">Header (HTML / Markdown from template pipeline)</Label>
                <Textarea
                  id="cr-edit-h"
                  value={editHeader}
                  onChange={(e) => setEditHeader(e.target.value)}
                  rows={5}
                  className="font-mono text-sm"
                  data-testid="change-report-edit-header"
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="cr-edit-b">Body</Label>
                <Textarea
                  id="cr-edit-b"
                  value={editBody}
                  onChange={(e) => setEditBody(e.target.value)}
                  rows={12}
                  className="font-mono text-sm"
                  data-testid="change-report-edit-body"
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="cr-edit-f">Footnote</Label>
                <Textarea
                  id="cr-edit-f"
                  value={editFoot}
                  onChange={(e) => setEditFoot(e.target.value)}
                  rows={4}
                  className="font-mono text-sm"
                  data-testid="change-report-edit-footnote"
                />
              </div>
              <div className="flex flex-wrap gap-2">
                <Button
                  type="button"
                  onClick={() => void handleSaveEdits()}
                  disabled={saving}
                  data-testid="change-report-save"
                >
                  {saving ? 'Saving…' : 'Save'}
                </Button>
                <Button
                  type="button"
                  variant="secondary"
                  onClick={() => void handleClearEdits()}
                  disabled={saving}
                  data-testid="change-report-clear-edits"
                >
                  Clear overrides
                </Button>
              </div>
            </TabsContent>
          </Tabs>
        </div>
      )}

      <Dialog open={templateDialogOpen} onOpenChange={setTemplateDialogOpen}>
        <DialogContent className="max-w-3xl max-h-[90vh] overflow-y-auto" aria-describedby="tpl-desc">
          <DialogHeader>
            <DialogTitle>Change report templates</DialogTitle>
            <DialogDescription id="tpl-desc">
              Create a Mustache template triple (validated on save). Defaults can be scoped to this project or the whole
              tenant (tenant admins only).
            </DialogDescription>
          </DialogHeader>
          <Tabs defaultValue="create" className="w-full">
            <TabsList>
              <TabsTrigger value="create">Create</TabsTrigger>
              <TabsTrigger value="defaults">Defaults</TabsTrigger>
              <TabsTrigger value="preview">Preview (sample fixture)</TabsTrigger>
            </TabsList>
            <TabsContent value="create" className="space-y-3 pt-3">
              <div className="space-y-2">
                <Label htmlFor="tpl-semver">Semver (unique per tenant)</Label>
                <Input
                  id="tpl-semver"
                  value={tplSemver}
                  onChange={(e) => setTplSemver(e.target.value)}
                  className="font-mono"
                  placeholder="e.g. 1.0.1"
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="tpl-h">Header template</Label>
                <Textarea id="tpl-h" value={tplHeader} onChange={(e) => setTplHeader(e.target.value)} rows={4} className="font-mono text-xs" />
              </div>
              <div className="space-y-2">
                <Label htmlFor="tpl-b">Body template</Label>
                <Textarea id="tpl-b" value={tplBody} onChange={(e) => setTplBody(e.target.value)} rows={10} className="font-mono text-xs" />
              </div>
              <div className="space-y-2">
                <Label htmlFor="tpl-f">Footnote template</Label>
                <Textarea id="tpl-f" value={tplFoot} onChange={(e) => setTplFoot(e.target.value)} rows={4} className="font-mono text-xs" />
              </div>
              <Button type="button" onClick={() => void handleCreateTemplate()} disabled={tplCreating}>
                {tplCreating ? 'Creating…' : 'Create template version'}
              </Button>
            </TabsContent>
            <TabsContent value="defaults" className="space-y-3 pt-3">
              <div className="space-y-2">
                <Label>Template version</Label>
                <Select value={defaultPick} onValueChange={setDefaultPick}>
                  <SelectTrigger>
                    <SelectValue placeholder="Select template" />
                  </SelectTrigger>
                  <SelectContent>
                    {templates.map((t) => (
                      <SelectItem key={t.id} value={t.id}>
                        {t.semver} · {t.id.slice(0, 8)}…
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="flex flex-wrap gap-2">
                <Button type="button" variant="secondary" onClick={() => void handleSetProjectDefault()}>
                  Set as project default
                </Button>
                <Button
                  type="button"
                  variant="secondary"
                  onClick={() => void handleSetTenantDefault()}
                  disabled={!effectiveIsAdmin}
                  title={!effectiveIsAdmin ? 'Tenant administrators only' : undefined}
                >
                  Set as tenant default
                </Button>
                <Button type="button" variant="outline" onClick={() => void handleClearProjectDefault()}>
                  Clear project override
                </Button>
              </div>
            </TabsContent>
            <TabsContent value="preview" className="space-y-3 pt-3">
              {previewBlocks.err ? <Alert variant="error">{previewBlocks.err}</Alert> : null}
              <section>
                <h4 className="text-sm font-medium text-gray-900 dark:text-white mb-1">Header preview</h4>
                <SafeMarkdown content={previewBlocks.h} />
              </section>
              <section>
                <h4 className="text-sm font-medium text-gray-900 dark:text-white mb-1">Body preview</h4>
                <SafeMarkdown content={previewBlocks.b} />
              </section>
              <section>
                <h4 className="text-sm font-medium text-gray-900 dark:text-white mb-1">Footnote preview</h4>
                <SafeMarkdown content={previewBlocks.f} />
              </section>
            </TabsContent>
          </Tabs>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => setTemplateDialogOpen(false)}>
              Close
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
