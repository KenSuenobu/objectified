'use client';

import * as React from 'react';
import { BookOpenCheck, Plus, Shield, ShieldCheck, Sparkles } from 'lucide-react';

import { Alert } from '@/app/components/ui/Alert';
import { Button } from '@/app/components/ui/Button';
import { TAB_COUNT_CLASS, TAB_LIST_CLASS, tabTriggerClass } from '@/app/components/ui/tabStyles';
import { cn } from '@lib/utils';
import PageHeader from '@/app/components/shell/PageHeader';
import { Page, PageBody } from '@/app/components/shell/pageChrome';
import type { ShortcutBinding } from '@lib/shortcuts';
import { useShortcuts } from '@/app/hooks/useShortcuts';

import {
  AssignGuideDialog,
  DeleteGuideDialog,
  EditGuideDialog,
  GuideFormDialog,
  StyleGuidesTable,
  findBuiltinGuide,
  type AssignableProject,
  type GuideDraft,
  type GuideFormMode,
  type StyleGuide,
} from '@/app/components/ade/styleGuides';

import QualityPolicyPanel from './QualityPolicyPanel';
import VerificationPolicyPanel from './VerificationPolicyPanel';
import {
  fetchMyPermissions,
  fetchProjectOptions,
  styleGuidesApi,
  type MyPermissions,
  type StyleGuideList,
} from './api';

/**
 * Style guides — `/ade/dashboard/style-guides` (HIVE-5.6, #5309).
 *
 * Authority: `docs/mockups/govern/style-guides.html`, whose **Notes → Keeps (1:1)** list is
 * this ticket's acceptance criteria; DESIGN.md §5.3 (page header), §7 (dialogs), §8 (list).
 *
 * ### What this page owns
 *
 * The guides, the five writes, which tab is showing and which overlay is open. How a guide is
 * *drawn* is `StyleGuidesTable`, the four dialogs are their own components, and the two
 * policy panels load their own data on mount — so an unopened tab still costs nothing, which
 * is the property the screen this replaces had and is worth keeping.
 *
 * ### The three governance sections are one screen, not three
 *
 * A guide decides *how* a document is scored; the import/export policy decides *what score is
 * good enough* to bring it in or send it out (IXH-2.3); the verification policy decides
 * *what evidence* a publish or deploy needs (ECA-3.1). They are three answers to "what does
 * this workspace insist on", which is why they share a header and a tab strip rather than
 * three sidebar entries.
 *
 * ### Non-admins get a read-only screen with the reason on it
 *
 * Every mutation here is tenant-admin only and the REST layer enforces it. The screen this
 * replaces simply removed the controls, so a member saw a table with no verbs and no
 * explanation. The controls are still absent — offering a button whose write will be refused
 * is worse — but a banner now says who may use them and what a member can still do. That is
 * the ticket's "read-only treatment, not hidden controls": what changes is that the absence
 * is *stated*.
 */

/** Where the breadcrumb's first step goes. */
const HOME_ROUTE = '/ade/dashboard';

/** The screen's sections, one per tab. */
type StyleGuidesTab = 'guides' | 'quality' | 'verification';

/** The three tabs, in the order the mockup shows them. */
const SECTIONS: ReadonlyArray<{
  id: StyleGuidesTab;
  label: string;
  icon: React.ComponentType<{ className?: string }>;
}> = [
  { id: 'guides', label: 'Style guides', icon: BookOpenCheck },
  { id: 'quality', label: 'Import & export policy', icon: ShieldCheck },
  { id: 'verification', label: 'Verification policy', icon: Shield },
];

/**
 * The page's own `N`, registered only while creating is possible.
 *
 * HIVE-3.7's registry is explicit that a chip promising a chord which does not fire is the
 * thing the registry exists to prevent — so this is not declared for a member, nor while a
 * policy tab is showing, because on neither does `N` mean anything.
 */
const CREATE_SHORTCUT_ID = 'style-guides-create';

/** Which overlay, if any, is open over the page. */
type GuideOverlay = 'none' | 'create' | 'edit' | 'assign' | 'delete';

/**
 * Turn a caught failure into the sentence to show.
 *
 * @param error Whatever was caught.
 * @param fallback What to say when the failure carried no message.
 * @returns The sentence.
 */
function describeFailure(error: unknown, fallback: string): string {
  return error instanceof Error && error.message ? error.message : fallback;
}

/**
 * The style guides page.
 *
 * @returns The header with its three tabs, the guides list, the two policy panels and the
 *   four overlays.
 */
export default function StyleGuidesClient() {
  const [guides, setGuides] = React.useState<StyleGuide[]>([]);
  const [projects, setProjects] = React.useState<AssignableProject[]>([]);
  const [permissions, setPermissions] = React.useState<MyPermissions | null>(null);
  const [loading, setLoading] = React.useState(true);
  const [busy, setBusy] = React.useState(false);

  /**
   * Why the list could not be read.
   *
   * Kept apart from {@link writeError} because the two belong in different places, the split
   * `MembersClient` settled on and 5.4 and 5.5 kept. A load failure leaves the table with
   * nothing to draw, and a table with nothing to draw says "No style guides yet." — a claim
   * about the workspace rather than about the request. It therefore goes *into* the card, as
   * `DataTable`'s own error state with a retry beside it.
   */
  const [loadError, setLoadError] = React.useState<string | null>(null);

  /**
   * A write that failed with no dialog open to report into.
   *
   * There are two: the assign dialog's three writes are immediate and report to the dialog
   * itself, and everything else reports to the overlay that asked for it. This is the last
   * resort, and it is also what the assign dialog is handed.
   */
  const [writeError, setWriteError] = React.useState('');

  const [tab, setTab] = React.useState<StyleGuidesTab>('guides');
  const [overlay, setOverlay] = React.useState<GuideOverlay>('none');
  /** Which guide the open overlay is about. An id, so a reload refreshes what it shows. */
  const [overlayGuideId, setOverlayGuideId] = React.useState<string | null>(null);
  /** What the create dialog was opened for — decides its title and its prefilled name. */
  const [createMode, setCreateMode] = React.useState<GuideFormMode>('new');

  const canMutate = Boolean(permissions?.is_admin);
  const recommended = React.useMemo(() => findBuiltinGuide(guides), [guides]);
  const overlayGuide = React.useMemo(
    () => guides.find((guide) => guide.id === overlayGuideId) ?? null,
    [guides, overlayGuideId]
  );

  // ---- load -----------------------------------------------------------------------------

  const loadGuides = React.useCallback(async () => {
    setLoading(true);
    setLoadError(null);
    try {
      // The three reads are independent: a refused projects read must not cost the reader
      // their guide list, so only the guide list's failure is the page's failure.
      const [list, myPermissions, projectOptions] = await Promise.all([
        styleGuidesApi<StyleGuideList>(''),
        fetchMyPermissions(),
        fetchProjectOptions().catch(() => [] as AssignableProject[]),
      ]);
      setGuides(list?.guides ?? []);
      setPermissions(myPermissions);
      setProjects(projectOptions);
    } catch (error) {
      setGuides([]);
      setLoadError(describeFailure(error, 'Failed to load style guides'));
    } finally {
      setLoading(false);
    }
  }, []);

  React.useEffect(() => {
    void loadGuides();
  }, [loadGuides]);

  // ---- writes ---------------------------------------------------------------------------

  const openCreate = React.useCallback((mode: GuideFormMode, guideId: string | null) => {
    setCreateMode(mode);
    setOverlayGuideId(guideId);
    setOverlay('create');
  }, []);

  const createShortcuts = React.useMemo<readonly ShortcutBinding[]>(
    () =>
      canMutate && tab === 'guides'
        ? [
            {
              id: CREATE_SHORTCUT_ID,
              scope: 'list',
              description: 'New style guide',
              chord: { key: 'n' },
              run: () => openCreate('new', null),
            },
          ]
        : [],
    [canMutate, openCreate, tab]
  );
  useShortcuts(createShortcuts);

  /**
   * Run one write, then reload the list.
   *
   * @param fallback What to say if the failure carried no message.
   * @param write The call.
   * @returns `null` on success, or the sentence to show.
   */
  const runWrite = React.useCallback(
    async (fallback: string, write: () => Promise<unknown>): Promise<string | null> => {
      setBusy(true);
      try {
        await write();
        await loadGuides();
        return null;
      } catch (error) {
        return describeFailure(error, fallback);
      } finally {
        setBusy(false);
      }
    },
    [loadGuides]
  );

  const handleCreate = React.useCallback(
    (draft: GuideDraft) =>
      runWrite('Failed to create the style guide', () =>
        styleGuidesApi<StyleGuide>('', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            name: draft.name,
            description: draft.description || null,
            sourceGuideId: draft.sourceGuideId || null,
          }),
        })
      ),
    [runWrite]
  );

  const handleEdit = React.useCallback(
    (name: string, description: string) => {
      const guideId = overlayGuideId;
      if (!guideId) return Promise.resolve('No guide selected.');
      return runWrite('Failed to save the style guide', () =>
        styleGuidesApi<StyleGuide>(guideId, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name, description }),
        })
      );
    },
    [overlayGuideId, runWrite]
  );

  const handleDelete = React.useCallback(
    (guide: StyleGuide) =>
      runWrite('Failed to delete the style guide', () =>
        styleGuidesApi(guide.id, { method: 'DELETE' })
      ),
    [runWrite]
  );

  /** The assign dialog's three writes report to the dialog, which stays open. */
  const runAssignWrite = React.useCallback(
    (fallback: string, write: () => Promise<unknown>) => {
      setWriteError('');
      void runWrite(fallback, write).then((failure) => {
        if (failure) setWriteError(failure);
      });
    },
    [runWrite]
  );

  const handleMakeDefault = React.useCallback(
    (guide: StyleGuide) =>
      runAssignWrite('Failed to make this guide the tenant default', () =>
        styleGuidesApi(`${guide.id}/default`, { method: 'PUT' })
      ),
    [runAssignWrite]
  );

  const handleAssignProject = React.useCallback(
    (guide: StyleGuide, projectId: string) =>
      runAssignWrite('Failed to assign the project', () =>
        styleGuidesApi(`${guide.id}/assignments/projects/${projectId}`, { method: 'PUT' })
      ),
    [runAssignWrite]
  );

  const handleUnassignProject = React.useCallback(
    (projectId: string) =>
      runAssignWrite('Failed to unassign the project', () =>
        styleGuidesApi(`assignments/projects/${projectId}`, { method: 'DELETE' })
      ),
    [runAssignWrite]
  );

  const closeOverlay = React.useCallback(() => {
    setOverlay('none');
    setWriteError('');
  }, []);

  const guideHref = React.useCallback(
    (guide: StyleGuide) => `/ade/dashboard/style-guides/${guide.id}`,
    []
  );

  // ---- the page --------------------------------------------------------------------------

  return (
    <Page>
      <PageHeader
        breadcrumb={[
          { label: 'Home', href: HOME_ROUTE },
          { label: 'Govern' },
          { label: 'Style guides' },
        ]}
        title="Style guides"
        description="Governance rules your specs are scored against."
        actions={
          canMutate && tab === 'guides' ? (
            <>
              {recommended && (
                <Button
                  variant="outline"
                  data-testid="style-guides-start-recommended"
                  disabled={busy}
                  onClick={() => openCreate('recommended', recommended.id)}
                >
                  <Sparkles aria-hidden />
                  Start from Recommended
                </Button>
              )}
              <Button
                kbd="N"
                data-testid="style-guides-create"
                disabled={busy}
                onClick={() => openCreate('new', null)}
              >
                <Plus aria-hidden />
                New guide
              </Button>
            </>
          ) : undefined
        }
        tabs={
          /* A hand-built strip on the shared classes rather than `ui/Tabs`: Radix's
             `Tabs.Root` is a single element that would have to wrap the header *and* the
             body, and `.page` is a flex column whose two children are exactly those two —
             an extra element between them collapses the layout. The roles, the selected
             state and the panel association are all stated below, which is what the
             primitive would have provided. */
          <div role="tablist" aria-label="Style guide sections" className={TAB_LIST_CLASS}>
            {SECTIONS.map((section) => (
              <button
                key={section.id}
                type="button"
                role="tab"
                id={`style-guides-tab-${section.id}`}
                aria-selected={tab === section.id}
                aria-controls={`style-guides-panel-${section.id}`}
                data-testid={`style-guides-tab-${section.id}`}
                className={tabTriggerClass({ active: tab === section.id })}
                onClick={() => setTab(section.id)}
              >
                <section.icon aria-hidden className="sg-tab-glyph" />
                {section.label}
                {section.id === 'guides' && !loading && (
                  <span className={cn(TAB_COUNT_CLASS, 'sg-tab-count')}>{guides.length}</span>
                )}
              </button>
            ))}
          </div>
        }
      />

      <PageBody>
        {/* The read-only treatment: the reason the verbs are missing, said once, above
            everything they are missing from. */}
        {/* `info`, not the mockup's untinted `.banner--neutral`: `Alert`'s neutral tone is
            `--fg-muted` on `--bg-subtle`, which measures 4.35:1 in Solarized — under AA, and
            the same pair HIVE-5.4 measured and avoided. `info` is a designed soft/ink pair
            and clears AA in all nine themes. */}
        {!loading && !canMutate && (
          <Alert variant="info" data-testid="style-guides-readonly">
            <span>
              <strong>Read-only for members.</strong> Only tenant administrators can create,
              assign or edit style guides and policies. You can open any guide and browse its
              rules.
            </span>
          </Alert>
        )}

        {writeError && overlay !== 'assign' && (
          <Alert variant="error" data-testid="style-guides-error" onClose={() => setWriteError('')}>
            {writeError}
          </Alert>
        )}

        {tab === 'guides' && (
          <div
            role="tabpanel"
            id="style-guides-panel-guides"
            aria-labelledby="style-guides-tab-guides"
            data-testid="style-guides-panel-guides"
          >
            <StyleGuidesTable
            guides={guides}
            loading={loading}
            error={loadError}
            onRetry={() => void loadGuides()}
            canMutate={canMutate}
            busy={busy}
            onAssign={(guide) => {
              setOverlayGuideId(guide.id);
              setWriteError('');
              setOverlay('assign');
            }}
            onDuplicate={(guide) => openCreate('duplicate', guide.id)}
            onEdit={(guide) => {
              setOverlayGuideId(guide.id);
              setOverlay('edit');
            }}
            onDelete={(guide) => {
              setOverlayGuideId(guide.id);
              setOverlay('delete');
            }}
            onCreate={() => openCreate('new', null)}
            onStartFromRecommended={() =>
              recommended && openCreate('recommended', recommended.id)
            }
              hasRecommended={Boolean(recommended)}
              guideHref={guideHref}
            />
          </div>
        )}

        {/* A guide decides how a document is scored; the quality policy decides what score is
            good enough to import or export it (IXH-2.3). Non-admins see it read-only, because
            a user who cannot see the policy cannot understand why a commit was refused. */}
        {tab === 'quality' && (
          <div
            role="tabpanel"
            id="style-guides-panel-quality"
            aria-labelledby="style-guides-tab-quality"
            data-testid="style-guides-panel-quality"
          >
            <QualityPolicyPanel readOnly={!canMutate} />
          </div>
        )}

        {tab === 'verification' && (
          <div
            role="tabpanel"
            id="style-guides-panel-verification"
            aria-labelledby="style-guides-tab-verification"
            data-testid="style-guides-panel-verification"
          >
            <VerificationPolicyPanel readOnly={!canMutate} />
          </div>
        )}
      </PageBody>

      <GuideFormDialog
        open={overlay === 'create'}
        onOpenChange={(open) => !open && closeOverlay()}
        mode={createMode}
        sourceGuide={createMode === 'new' ? null : overlayGuide}
        guides={guides}
        onSubmit={handleCreate}
      />

      <EditGuideDialog
        open={overlay === 'edit'}
        onOpenChange={(open) => !open && closeOverlay()}
        guide={overlayGuide}
        guideHref={overlayGuide ? guideHref(overlayGuide) : HOME_ROUTE}
        onSubmit={handleEdit}
      />

      <AssignGuideDialog
        open={overlay === 'assign'}
        onOpenChange={(open) => !open && closeOverlay()}
        guide={overlayGuide}
        projects={projects}
        busy={busy}
        error={writeError || null}
        onMakeDefault={handleMakeDefault}
        onAssignProject={handleAssignProject}
        onUnassignProject={handleUnassignProject}
      />

      <DeleteGuideDialog
        open={overlay === 'delete'}
        onOpenChange={(open) => !open && closeOverlay()}
        guide={overlayGuide}
        guides={guides}
        onConfirm={handleDelete}
      />
    </Page>
  );
}
