'use client';

/**
 * Page chrome — live showcase gallery (HIVE-3.5, #5291).
 *
 * The production counterpart of `docs/mockups/DESIGN.md` §5.3: a data-free route at
 * `/design-system/page-header` that renders `Page` / `PageHeader` / `PageBody` at page
 * scale, in the three shapes the app's screens actually take.
 *
 * It exists because two of this ticket's acceptance criteria are questions about *layout*
 * that jsdom cannot answer — it compiles no stylesheet and has no scroll:
 *
 *   • **"Long titles + 4 actions at 1280 px produce no horizontal scroll."** The only way
 *     to check is to measure the document at that width, with a title long enough to break
 *     a header that forgot `min-width: 0`.
 *   • **"Sticky header stays legible over scrolled content in all themes."** Which means
 *     scrolling something and reading a bounding box, then doing it again per palette.
 *
 * `e2e/hive-page-header.spec.ts` drives exactly that here. Each specimen is a real scroll
 * container in a fixed-height frame, so all three are on screen at once and each one
 * scrolls under its own header.
 *
 * Sibling galleries: `/design-system/hive` (the primitives), `/design-system/mcp`.
 */

import * as React from 'react';
import { ArrowUpRight, Download, Plus, Settings2, Trash2, Upload } from 'lucide-react';
import {
  Avatar,
  Badge,
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  Tabs,
  TabsContent,
  TabsCount,
  TabsList,
  TabsTrigger,
  TooltipProvider,
} from '@/app/components/ui';
import { FormatPill } from '@/app/components/ui/catalog/FormatPill';
import { Page, PageBody, PageHeader } from '@/app/components/shell';
import PreferenceAxes from '../PreferenceAxes';

/**
 * A title long enough to break a header that forgot `min-width: 0`.
 *
 * Real, not lorem: this is the shape of a name a customer gives an integration, and it is
 * the case that used to push the action cluster off the right edge of every screen.
 */
const LONG_TITLE =
  'Contoso Health clearinghouse claims interchange — professional 837P, production';

/** The specimen frame's height: tall enough to scroll under, short enough to fit three. */
const FRAME_CLASS =
  'flex h-[26rem] flex-col overflow-hidden rounded-lg border border-border bg-canvas';

/** Props for {@link Specimen}. */
interface SpecimenProps {
  /** `data-testid` of the frame, which the e2e suite scrolls and measures. */
  id: string;
  /** What this specimen is for. */
  title: string;
  /** Why it is here — the rule or the acceptance criterion it demonstrates. */
  note: string;
  /** The `Page` under test. */
  children: React.ReactNode;
}

/**
 * One framed specimen: a caption, then a real scroll container.
 *
 * @param props See {@link SpecimenProps}.
 * @returns The captioned frame.
 */
function Specimen({ id, title, note, children }: SpecimenProps) {
  return (
    <section className="flex flex-col gap-2">
      <div>
        <h2 className="text-lg font-semibold text-fg">{title}</h2>
        <p className="max-w-[72ch] text-sm text-fg-muted">{note}</p>
      </div>
      <div className={FRAME_CLASS} data-testid={id}>
        {children}
      </div>
    </section>
  );
}

/**
 * Filler that gives a specimen something to scroll under its header.
 *
 * @param props.count How many cards to draw.
 * @returns The cards.
 */
function BodyFiller({ count = 4 }: { count?: number }) {
  return (
    <>
      {Array.from({ length: count }, (_, index) => (
        <Card key={index}>
          <CardHeader>
            <CardTitle>Section {index + 1}</CardTitle>
            <CardDescription>
              Page sections are separated by the body&apos;s own 24 px gap, so a page never
              spells its own rhythm.
            </CardDescription>
          </CardHeader>
          <CardContent className="text-sm text-fg-muted">
            Scroll this frame: the header stays put and the content passes behind it.
          </CardContent>
        </Card>
      ))}
    </>
  );
}

/**
 * The gallery.
 *
 * @returns Three page-chrome specimens, over the shared preference switchers.
 */
export default function PageHeaderGalleryPage() {
  return (
    <TooltipProvider>
      <main className="mx-auto flex max-w-[75rem] flex-col gap-8 p-[var(--page-pad)]">
        <header className="flex flex-col gap-3">
          <h1 className="text-3xl font-semibold tracking-[-0.02em] text-fg">
            Page chrome{' '}
            <Badge variant="honey" size="lg">
              HIVE-3.5
            </Badge>
          </h1>
          <p className="max-w-[72ch] text-sm text-fg-muted">
            <code className="mono">Page</code> · <code className="mono">PageHeader</code> ·{' '}
            <code className="mono">PageBody</code>, the sticky header of{' '}
            <code className="mono">docs/mockups/DESIGN.md</code> §5.3 and the frame it sits in.
            Each specimen below is a real scroll container — scroll one and its header stays.
          </p>
          <PreferenceAxes />
        </header>

        {/* ---- 1. The list page, and the acceptance criterion --------------------- */}
        <Specimen
          id="specimen-list"
          title="List page — long title, four actions"
          note="One primary action in ink; the rest outline, soft and ghost. The title block carries min-width: 0 and the cluster wraps, so this pair cannot scroll the document sideways however long the name gets."
        >
          <Page>
            <PageHeader
              breadcrumb={[
                { label: 'Acme Corp', href: '/design-system/page-header' },
                { label: 'Build' },
                { label: 'Projects' },
              ]}
              title={LONG_TITLE}
              description="4 projects · avg quality 84 · 3 active · 1 deleted"
              actions={
                <>
                  <Button variant="ghost">
                    <Settings2 aria-hidden />
                    Settings
                  </Button>
                  <Button variant="soft">
                    <Download aria-hidden />
                    Export
                  </Button>
                  <Button variant="outline">
                    <Upload aria-hidden />
                    Import
                  </Button>
                  <Button variant="primary" kbd="N">
                    <Plus aria-hidden />
                    New project
                  </Button>
                </>
              }
            />
            <PageBody>
              <BodyFiller />
            </PageBody>
          </Page>
        </Specimen>

        {/* ---- 2. The detail page: leading mark, badge, meta row, tabs ------------ */}
        <Specimen
          id="specimen-detail"
          title="Detail page — mark, status badge, metadata row, tabs"
          note="The title truncates here because the breadcrumb already carries the name in full. Radix Tabs wrap the whole page in display: contents, so the strip can live in the header while its panels live in the body."
        >
          <Tabs defaultValue="overview" className="contents">
            <Page>
              <PageHeader
                breadcrumb={[
                  { label: 'Acme Corp', href: '/design-system/page-header' },
                  { label: 'Bring in' },
                  { label: 'Catalog', href: '/design-system/page-header' },
                  { label: 'Claims 837P' },
                ]}
                leading={<Avatar name="Claims 837P" shape="hex" size="lg" />}
                title="Claims 837P"
                truncateTitle
                badge={<Badge status="active" dot>Active</Badge>}
                description="Professional healthcare claim interchange from the Contoso Health clearinghouse."
                meta={
                  <>
                    <FormatPill format="x12" />
                    <Badge variant="outline">Data schema</Badge>
                    <Badge variant="neutral">Uploaded file</Badge>
                  </>
                }
                actions={
                  <>
                    <Button variant="ghost" aria-label="Delete catalog item">
                      <Trash2 aria-hidden />
                    </Button>
                    <Button variant="outline">
                      <ArrowUpRight aria-hidden />
                      Export
                    </Button>
                    <Button variant="primary">Convert to OpenAPI</Button>
                  </>
                }
                tabs={
                  <TabsList>
                    <TabsTrigger value="overview">Overview</TabsTrigger>
                    <TabsTrigger value="versions">
                      Versions <TabsCount>6</TabsCount>
                    </TabsTrigger>
                    <TabsTrigger value="lint">
                      Lint <TabsCount>2</TabsCount>
                    </TabsTrigger>
                  </TabsList>
                }
              />
              <PageBody>
                <TabsContent value="overview" className="flex flex-col gap-6">
                  <BodyFiller />
                </TabsContent>
                <TabsContent value="versions">
                  <Card>
                    <CardHeader>
                      <CardTitle>Versions</CardTitle>
                    </CardHeader>
                  </Card>
                </TabsContent>
                <TabsContent value="lint">
                  <Card>
                    <CardHeader>
                      <CardTitle>Lint</CardTitle>
                    </CardHeader>
                  </Card>
                </TabsContent>
              </PageBody>
            </Page>
          </Tabs>
        </Specimen>

        {/* ---- 3. The form page: a narrow body under a full-width header ---------- */}
        <Specimen
          id="specimen-form"
          title="Form page — narrow body (920 px)"
          note="Reading and form pages cap the body at 920 px while the header keeps the page's width, matching sources/repository-new.html: a narrow column of fields reads as a form, a narrow title bar reads as a dialog."
        >
          <Page width="narrow">
            <PageHeader
              breadcrumb={[
                { label: 'Acme Corp', href: '/design-system/page-header' },
                { label: 'Repositories', href: '/design-system/page-header' },
                { label: 'Add repository' },
              ]}
              title="Add a repository"
              description="Register a repository so Apiome can scan it for importable specifications."
              actions={<Button variant="ghost">Cancel</Button>}
            />
            <PageBody>
              <BodyFiller count={3} />
            </PageBody>
          </Page>
        </Specimen>
      </main>
    </TooltipProvider>
  );
}
