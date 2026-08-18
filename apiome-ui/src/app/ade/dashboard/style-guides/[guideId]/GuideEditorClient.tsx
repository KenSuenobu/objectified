'use client';

import * as React from 'react';
import { useRouter } from 'next/navigation';
import { ArrowLeft, BookX, FileCode2, ListChecks, ShieldCheck } from 'lucide-react';

import { Alert } from '@/app/components/ui/Alert';
import { Badge } from '@/app/components/ui/Badge';
import { Button } from '@/app/components/ui/Button';
import { EmptyState } from '@/app/components/ui/EmptyState';
import { TAB_COUNT_CLASS, TAB_LIST_CLASS, tabTriggerClass } from '@/app/components/ui/tabStyles';
import PageHeader from '@/app/components/shell/PageHeader';
import { Page, PageBody } from '@/app/components/shell/pageChrome';
import { useDialog } from '@/app/components/providers/DialogProvider';
import { useUnsavedChangesPrompt } from '@/app/hooks/useUnsavedChangesPrompt';
import { cn } from '@lib/utils';

import {
  CustomRulesTab,
  PolicyTab,
  RuleCatalogTab,
  discardWarningSentence,
  guideReadOnlyReason,
  useCustomRules,
  useGuidePolicy,
  useRuleCatalog,
} from '@/app/components/ade/styleGuides/guideDetail';

import { fetchMyPermissions } from '../api';

/**
 * Style guide detail — `/ade/dashboard/style-guides/[guideId]` (HIVE-5.7, #5310).
 *
 * Authority: `docs/mockups/govern/style-guide-detail.html`, whose **Notes → Keeps (1:1)**
 * list is this ticket's acceptance criteria; DESIGN.md §5.3 (page header), §7 (dialogs).
 *
 * ### What this page owns
 *
 * The guide's identity, which tab is showing, who the viewer is — and, crucially, **all
 * three drafts**. How each tab is drawn is its own component; what each tab loads and edits
 * is a hook in `guideDetail/guideEditorState.ts` called from here.
 *
 * That last point is the ticket's fourth acceptance criterion and the fix for its problem
 * statement. In the screen this replaces each tab was a component that fetched on mount and
 * held its own draft, so switching tabs unmounted it and discarded the draft silently — the
 * "dirty state is easy to lose". Hoisting the state means a draft outlives its panel, while
 * the `active` flag on two of the hooks means an unopened tab still fetches nothing.
 *
 * ### Leaving with unsaved work
 *
 * Two guards, because there are two ways to leave. `useUnsavedChangesPrompt` covers what
 * leaves the document — a reload, a close, an external link — with the browser's own
 * prompt, which is the only thing that can stop those. The back arrow is an in-app route
 * change, which `beforeunload` never sees, so it asks first through the shared confirm
 * (HIVE-2.7) with the mockup's own copy. Both count all three tabs: a reader with edits on
 * the catalog and in the YAML is about to lose both, and a warning that mentioned one of
 * them would be worse than none.
 *
 * ### One permissions read for the page
 *
 * `is_admin` gates the catalog, the custom rules and the policy alike, and the screen this
 * replaces fetched it twice — once in the page and once in the custom-rules tab. It is read
 * here, once, and handed down.
 */

/** Where the back arrow and the not-found state go. */
const LIST_ROUTE = '/ade/dashboard/style-guides';

/** The page's three sections, one per tab. */
type GuideTab = 'catalog' | 'custom' | 'policy';

/** The tabs, in the order the mockup shows them. */
const SECTIONS: ReadonlyArray<{
  id: GuideTab;
  label: string;
  icon: React.ComponentType<{ className?: string }>;
}> = [
  { id: 'catalog', label: 'Rule catalog', icon: ListChecks },
  { id: 'custom', label: 'Custom rules', icon: FileCode2 },
  { id: 'policy', label: 'Policy', icon: ShieldCheck },
];

/**
 * The style-guide detail page.
 *
 * @param props.guideId The guide this route is for.
 * @returns The header with its three tabs, the panel that is showing, and its overlays.
 */
export default function GuideEditorClient({ guideId }: { guideId: string }) {
  const router = useRouter();
  const { confirm } = useDialog();

  const [tab, setTab] = React.useState<GuideTab>('catalog');
  /**
   * Which panels have been opened at least once.
   *
   * A panel is mounted from its first visit onwards and never unmounted again, which is
   * what keeps a Monaco instance, its scroll position and its markers alive across a tab
   * switch. Tracked here rather than inferred from "has this tab's data arrived" so a tab
   * whose *read failed* also keeps whatever the reader typed into it.
   */
  const [opened, setOpened] = React.useState<ReadonlySet<GuideTab>>(
    () => new Set<GuideTab>(['catalog'])
  );
  const [isAdmin, setIsAdmin] = React.useState(false);

  const openTab = React.useCallback((next: GuideTab) => {
    setTab(next);
    setOpened((prev) => (prev.has(next) ? prev : new Set([...prev, next])));
  }, []);

  const catalog = useRuleCatalog(guideId);
  const custom = useCustomRules(guideId, tab === 'custom');
  const policy = useGuidePolicy(guideId, tab === 'policy');

  React.useEffect(() => {
    let cancelled = false;
    // A refused permissions read means "not an administrator", which is the safe reading:
    // every control it gates would have its write refused by the REST layer anyway.
    void fetchMyPermissions().then((permissions) => {
      if (!cancelled) setIsAdmin(Boolean(permissions?.is_admin));
    });
    return () => {
      cancelled = true;
    };
  }, []);

  const readOnlyReason = guideReadOnlyReason(catalog.view?.source, isAdmin);
  const readOnly = readOnlyReason !== null;

  const unsavedSentence = discardWarningSentence(
    catalog.modifiedIds.length,
    custom.dirty || policy.dirty
  );
  const dirty = unsavedSentence !== null;

  useUnsavedChangesPrompt(dirty);

  /** In-app back navigation: confirm first when changes would be lost. */
  const handleBack = React.useCallback(async () => {
    if (unsavedSentence) {
      const leave = await confirm({
        title: 'Discard unsaved changes?',
        message: unsavedSentence,
        variant: 'warning',
        confirmLabel: 'Discard and leave',
        cancelLabel: 'Keep editing',
      });
      if (!leave) return;
    }
    router.push(LIST_ROUTE);
  }, [confirm, router, unsavedSentence]);

  const notFound = !catalog.loading && !catalog.view;

  return (
    <Page>
      <PageHeader
        breadcrumb={[
          { label: 'Home', href: '/ade/dashboard' },
          { label: 'Govern' },
          { label: 'Style guides', href: LIST_ROUTE },
          { label: catalog.view?.guideName ?? 'Style guide' },
        ]}
        leading={
          <Button
            variant="ghost"
            size="icon"
            aria-label="Back to style guides"
            data-testid="guide-back"
            onClick={() => void handleBack()}
          >
            <ArrowLeft aria-hidden />
          </Button>
        }
        title={catalog.view?.guideName ?? 'Style guide'}
        truncateTitle
        badge={
          catalog.view?.source === 'builtin' ? <Badge variant="neutral">Built-in</Badge> : undefined
        }
        description="Tailor which built-in rules apply and how severely they score."
        actions={
          catalog.view ? (
            <Badge variant="outline" size="lg" data-testid="guide-enabled-count">
              {catalog.enabled} of {catalog.view.count} rules enabled
            </Badge>
          ) : undefined
        }
        tabs={
          /* A hand-built strip on the shared classes rather than `ui/Tabs`, for the reason
             the guides list records: `Tabs.Root` is a single element that would have to wrap
             the header *and* the body, and `.page` is a flex column whose two children are
             exactly those two. The roles, the selected state and the panel association are
             all stated below. */
          <div role="tablist" aria-label="Style guide sections" className={TAB_LIST_CLASS}>
            {SECTIONS.map((section) => (
              <button
                key={section.id}
                type="button"
                role="tab"
                id={`guide-tab-${section.id}`}
                aria-selected={tab === section.id}
                aria-controls={`guide-panel-${section.id}`}
                data-testid={`guide-tab-${section.id}`}
                className={tabTriggerClass({ active: tab === section.id })}
                onClick={() => openTab(section.id)}
              >
                <section.icon aria-hidden className="sg-tab-glyph" />
                {section.label}
                {section.id === 'catalog' && catalog.view && (
                  <span className={cn(TAB_COUNT_CLASS, 'sg-tab-count')}>
                    {catalog.view.count}
                  </span>
                )}
                {section.id === 'custom' && custom.view && (
                  <span className={cn(TAB_COUNT_CLASS, 'sg-tab-count')}>
                    {custom.view.ruleCount}
                  </span>
                )}
              </button>
            ))}
          </div>
        }
      />

      <PageBody>
        {notFound ? (
          <EmptyState
            icon={<BookX aria-hidden />}
            title="Style guide not found."
            description="It may have been deleted, or the link belongs to another workspace."
            action={
              <Button onClick={() => router.push(LIST_ROUTE)} data-testid="guide-not-found-back">
                <ArrowLeft aria-hidden />
                Back to style guides
              </Button>
            }
            data-testid="guide-not-found"
          />
        ) : (
          <>
            {/* A failed *read* leaves the page with nothing to draw and is reported above
                the tabs; a failed *write* is reported by the tab that attempted it. */}
            {catalog.error && !catalog.view && (
              <Alert
                variant="error"
                actions={
                  <Button size="sm" variant="outline" onClick={catalog.reload}>
                    Retry
                  </Button>
                }
                data-testid="guide-load-error"
              >
                {catalog.error}
              </Alert>
            )}

            <div
              role="tabpanel"
              id="guide-panel-catalog"
              aria-labelledby="guide-tab-catalog"
              data-testid="guide-panel-catalog"
              hidden={tab !== 'catalog'}
            >
              {catalog.error && catalog.view && (
                <Alert variant="error" onClose={catalog.clearError} data-testid="guide-save-error">
                  {catalog.error}
                </Alert>
              )}
              <RuleCatalogTab state={catalog} readOnlyReason={readOnlyReason} />
            </div>

            {/* The two lazy panels are mounted only once their tab has been opened, and stay
                mounted after that — which is what keeps a Monaco instance and its draft
                alive across a tab switch. `hidden` is what takes them out of the
                accessibility tree while another tab is showing. */}
            {opened.has('custom') ? (
              <div
                role="tabpanel"
                id="guide-panel-custom"
                aria-labelledby="guide-tab-custom"
                data-testid="guide-panel-custom"
                hidden={tab !== 'custom'}
              >
                <CustomRulesTab state={custom} readOnlyReason={readOnlyReason} />
              </div>
            ) : null}

            {opened.has('policy') ? (
              <div
                role="tabpanel"
                id="guide-panel-policy"
                aria-labelledby="guide-tab-policy"
                data-testid="guide-panel-policy"
                hidden={tab !== 'policy'}
              >
                <PolicyTab state={policy} readOnly={readOnly} />
              </div>
            ) : null}
          </>
        )}
      </PageBody>
    </Page>
  );
}
