'use client';

/**
 * Hive primitives — live showcase gallery (HIVE-2.1, #5280).
 *
 * The production counterpart of `docs/mockups/foundations/design-system.html`: a data-free
 * route at `/design-system/hive` that renders the §Buttons, §Forms, §Badges, §Status
 * vocabulary, §Cards, §Tabs, §Segmented, §Avatars, §Tables, §Overlays, §Feedback and
 * §Metrics sections of the mockup with the **real** `components/ui` primitives.
 * Standing beside the mockup it answers the only question that matters about a re-token —
 * does the component now look like the design language? — and it is where a theme, density
 * or font-scale regression shows up first.
 *
 * The switchers at the top write `data-theme` / `data-density` / `data-font-scale` straight
 * onto `<html>`, which is exactly what `PreferencesProvider` does (HIVE-1.3/1.4). This route
 * sits outside the `/ade` shell, so it has no provider of its own to ask.
 *
 * Sibling gallery: `/design-system/mcp` (the MCP primitives, V2-MCP-24.7).
 */

import * as React from 'react';
import {
  Filter,
  FolderOpen,
  LayoutGrid,
  List,
  Plus,
  SearchX,
  Sparkles,
  Trash2,
  Upload,
  UploadCloud,
} from 'lucide-react';
import {
  Alert,
  AlertDescription,
  AlertTitle,
  Avatar,
  AvatarStack,
  Badge,
  Button,
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
  Checkbox,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
  Drawer,
  DrawerBody,
  DrawerClose,
  DrawerContent,
  DrawerDescription,
  DrawerFooter,
  DrawerHeader,
  DrawerOpenFullPageLink,
  DrawerTitle,
  DrawerTrigger,
  EmptyState,
  ErrorBanner,
  ErrorState,
  FormField,
  FreshnessPill,
  GRADE_LETTERS,
  GatedState,
  GradeGlyph,
  HTTP_METHODS,
  HealthPill,
  Input,
  Kbd,
  LoadingState,
  MethodChip,
  RadioGroup,
  RadioGroupItem,
  RecencyPill,
  Segmented,
  SegmentedItem,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Skeleton,
  SkeletonCard,
  SkeletonText,
  Spinner,
  Switch,
  Tabs,
  TabsContent,
  TabsCount,
  TabsList,
  TabsTrigger,
  Textarea,
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '@/app/components/ui';
// The metrics set (HIVE-2.6, #5285) is imported by path rather than from the `ui` barrel — see
// the note in `components/ui/metrics/index.ts` about the MCP chart kit's same-named `Sparkline`.
import {
  Meter,
  Progress,
  Ring,
  Sparkline,
  Stat,
  StatGrid,
} from '@/app/components/ui/metrics';
import { FormatPill } from '@/app/components/ui/catalog/FormatPill';
import { GradeChip } from '@/app/components/ui/catalog/GradeChip';
import { DENSITIES, FONT_SCALES } from '@/app/config/preferences';
import { SYSTEM_THEME_ID, appearanceOf, themes } from '@/app/config/themes';
import { TablesShowcase } from './TablesShowcase';

/**
 * The §Status vocabulary specimens (HIVE-2.4, #5283), grouped exactly as DESIGN.md §3.1
 * groups them — the point of the section is that the *grouping* is learnable, not that any
 * one badge looks nice.
 */
const VOCABULARIES: readonly { title: string; values: readonly string[] }[] = [
  { title: 'Version lifecycle', values: ['draft', 'review', 'published', 'deprecated', 'sunset', 'archived'] },
  { title: 'Visibility', values: ['private', 'public'] },
  { title: 'Health / jobs', values: ['healthy', 'completed', 'degraded', 'running', 'pending', 'down', 'failed', 'unknown'] },
  { title: 'Lint severity', values: ['error', 'warning', 'info', 'hint'] },
  { title: 'Keys / members', values: ['active', 'revoked', 'disabled', 'suspended'] },
  { title: 'Maturity', values: ['preview', 'beta', 'new'] },
];

/**
 * The formats DESIGN.md §3.1 names by hand, in its order, as raw `sourceFormat` tokens — so the
 * row also demonstrates that the pill resolves aliases (`x12`, `copybook`) to their entry.
 *
 * The last token is deliberately not a format: an unknown-but-present value keeps its raw text
 * on the neutral hue rather than disappearing, and that contract is worth seeing.
 */
const GALLERY_FORMATS: readonly string[] = [
  'openapi',
  'asyncapi',
  'graphql',
  'protobuf',
  'jsonschema',
  'wsdl',
  'x12',
  'copybook',
  'avro',
  'raml',
  'wit',
  'postman',
  'mystery-format',
];

/**
 * A fixed instant and a fixed "now" for the recency specimen.
 *
 * The gallery is a visual-regression surface, so nothing on it may read the wall clock: a
 * pill that says "2h ago" on one run and "3h ago" on the next is a diff every time.
 */
const GALLERY_NOW_MS = Date.parse('2026-01-15T12:00:00.000Z');
const GALLERY_TIMESTAMP = '2026-01-15T09:30:00.000Z';

/**
 * The three preference axes this gallery drives, derived from the same catalogues the
 * preferences pane reads — so a theme or scale added in HIVE-1.2/1.3 shows up here for free.
 *
 * `system` is excluded: it is a *choice*, not a palette, and `ThemeProvider` writes the
 * resolved id to `data-theme`. Writing `system` there would match no block at all.
 */
const AXES = [
  {
    attribute: 'data-theme',
    label: 'Theme',
    initial: 'light',
    options: themes
      .filter((theme) => theme.id !== SYSTEM_THEME_ID)
      .map((theme) => ({ value: theme.id, label: theme.name })),
  },
  {
    attribute: 'data-density',
    label: 'Density',
    initial: 'comfortable',
    options: DENSITIES.map((entry) => ({ value: entry.id, label: entry.label })),
  },
  {
    attribute: 'data-font-scale',
    label: 'Font scale',
    initial: 'md',
    options: FONT_SCALES.map((scale) => ({ value: scale.id, label: scale.label })),
  },
] as const;

/** One titled block of the gallery. */
function Section({
  id,
  title,
  description,
  children,
}: {
  id: string;
  title: string;
  description: string;
  children: React.ReactNode;
}) {
  return (
    <section id={id} className="scroll-mt-24">
      <Card variant="flat">
        <CardHeader>
          <CardTitle>{title}</CardTitle>
          <CardDescription>{description}</CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">{children}</CardContent>
      </Card>
    </section>
  );
}

/**
 * One ring per band of the HIVE-2.6 score scale, so a reviewer can see all four at once and
 * check that the boundary cases land where `ringTier` says they do.
 */
const RING_SPECIMENS: readonly { score: number | null; band: string; label: string }[] = [
  { score: 94, band: 'Excellent', label: 'Excellent score' },
  { score: 84, band: 'Good', label: 'Good score' },
  { score: 68, band: 'Fair', label: 'Fair score' },
  { score: 42, band: 'Poor', label: 'Poor score' },
  { score: null, band: 'Not scored', label: 'Technical debt' },
];

/** A tinted well the specimens sit in, so their own surface colour is visible. */
function Demo({ children, className }: { children: React.ReactNode; className?: string }) {
  return (
    <div
      className={
        'flex flex-wrap items-center gap-2.5 rounded-md bg-canvas p-4 shadow-[inset_0_0_0_1px_var(--border)] ' +
        (className ?? '')
      }
    >
      {children}
    </div>
  );
}

export default function HiveDesignSystemPage() {
  const [density, setDensity] = React.useState('comfortable');
  const [checked, setChecked] = React.useState(true);
  const [radio, setRadio] = React.useState('rest');
  const [dialogOpen, setDialogOpen] = React.useState(false);
  const [drawerOpen, setDrawerOpen] = React.useState(false);
  const [view, setView] = React.useState('cards');
  const [scope, setScope] = React.useState('mine');

  /** Write a preference axis onto `<html>`, the same place the preferences pane writes it. */
  const setAxis = (attribute: string, value: string) => {
    document.documentElement.setAttribute(attribute, value);
    // `ThemeProvider` hands next-themes the resolved *appearance*, which is what puts `.dark`
    // on `<html>` for every dark-based palette. The gallery has no provider, so it does the
    // same thing by hand — otherwise the rules keyed on `.dark` (the format pill's dark-base
    // settling, and every `dark:` utility not yet migrated) would be missing here and only
    // here, which is the one place a reviewer looks to catch them.
    if (attribute === 'data-theme') {
      const theme = themes.find((entry) => entry.id === value);
      document.documentElement.classList.toggle(
        'dark',
        theme ? appearanceOf(theme) === 'dark' : false,
      );
    }
  };

  return (
    <TooltipProvider>
      <main className="mx-auto flex max-w-[75rem] flex-col gap-6 p-[var(--page-pad)]">
        <header className="flex flex-col gap-3">
          <h1 className="text-3xl font-semibold tracking-[-0.02em] text-fg">
            Hive primitives{' '}
            <Badge variant="honey" size="lg">
              HIVE-2.1 · 2.2 · 2.3 · 2.4 · 2.5 · 2.6
            </Badge>
          </h1>
          <p className="max-w-[72ch] text-sm text-fg-muted">
            The real <code className="mono">components/ui</code> primitives, re-tokened against{' '}
            <code className="mono">docs/mockups/DESIGN.md</code> §7. Switch theme, density and font
            scale below — nothing here names a colour or a size, so all three reach every specimen.
          </p>
          <div className="flex flex-wrap gap-4">
            {AXES.map((axis) => (
              <label key={axis.attribute} className="flex items-center gap-2 text-sm text-fg-muted">
                {axis.label}
                <select
                  className="hive-control h-[var(--control-h)] rounded-md bg-surface px-3 text-sm text-fg"
                  defaultValue={axis.initial}
                  onChange={(event) => setAxis(axis.attribute, event.target.value)}
                >
                  {axis.options.map((option) => (
                    <option key={option.value} value={option.value}>
                      {option.label}
                    </option>
                  ))}
                </select>
              </label>
            ))}
          </div>
        </header>

        <Section
          id="buttons"
          title="Buttons"
          description="One primary per screen, in ink. Verbs, sentence case. Icon buttons carry a tooltip."
        >
          <Demo>
            <Button variant="primary" kbd="N">
              <Plus aria-hidden />
              New project
            </Button>
            <Button variant="accent">
              <UploadCloud aria-hidden />
              Publish
            </Button>
            <Button variant="outline">
              <Upload aria-hidden />
              Import
            </Button>
            <Button variant="soft">Secondary soft</Button>
            <Button variant="ghost">
              <Filter aria-hidden />
              Ghost
            </Button>
            <Button variant="danger">
              <Trash2 aria-hidden />
              Delete
            </Button>
            <Button variant="danger-soft">Danger soft</Button>
            <Button variant="honey">
              <Sparkles aria-hidden />
              Honey
            </Button>
            <Button variant="link">Link button</Button>
            <Button variant="outline" disabled>
              Disabled
            </Button>
          </Demo>
          <Demo>
            <Button size="sm" variant="primary">
              Small
            </Button>
            <Button size="sm" variant="outline">
              Small
            </Button>
            <Button variant="outline">Default</Button>
            <Button size="lg" variant="primary">
              Large
            </Button>
            <Tooltip>
              <TooltipTrigger asChild>
                <Button size="icon" variant="ghost" aria-label="More actions">
                  <Filter aria-hidden />
                </Button>
              </TooltipTrigger>
              <TooltipContent>More actions</TooltipContent>
            </Tooltip>
            <Button variant="outline" pill>
              <Sparkles aria-hidden />
              Pill
            </Button>
            <Button variant="outline">
              <Spinner size="xs" label="Saving" />
              Saving…
            </Button>
          </Demo>
        </Section>

        <Section
          id="forms"
          title="Forms"
          description="36 px controls, hairline inset borders, azure focus. Labels above, hints below, errors inline with an icon."
        >
          <div className="grid gap-6 md:grid-cols-2">
            <div className="flex flex-col gap-4">
              <FormField label="Project name" required>
                <Input placeholder="e.g. Payments API" />
              </FormField>
              <FormField label="Slug" helperText="Lowercase letters, numbers and dashes.">
                <Input className="mono" defaultValue="payments-api" />
              </FormField>
              <FormField label="Email" error="Enter a valid email address.">
                <Input defaultValue="ada@example" />
              </FormField>
              <FormField label="Domain category">
                <Select>
                  <SelectTrigger>
                    <SelectValue placeholder="None" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="finance">Finance</SelectItem>
                    <SelectItem value="logistics">Logistics</SelectItem>
                  </SelectContent>
                </Select>
              </FormField>
              <FormField label="Description">
                <Textarea placeholder="What does this API do?" />
              </FormField>
            </div>
            <div className="flex flex-col gap-4">
              <FormField label="Choice controls">
                <div className="flex flex-wrap items-center gap-4">
                  <label className="flex items-center gap-2 text-sm text-fg">
                    <Checkbox
                      checked={checked}
                      onCheckedChange={(next) => setChecked(next === true)}
                    />
                    Checkbox
                  </label>
                  <label className="flex items-center gap-2 text-sm text-fg">
                    <Checkbox checked="indeterminate" />
                    Mixed
                  </label>
                </div>
              </FormField>
              <FormField label="Protocol">
                <RadioGroup value={radio} onValueChange={setRadio}>
                  <RadioGroupItem value="rest" label="REST" />
                  <RadioGroupItem value="graphql" label="GraphQL" />
                  <RadioGroupItem value="grpc" label="gRPC" />
                </RadioGroup>
              </FormField>
              <div className="flex items-start justify-between gap-4 border-t border-border py-3">
                <div>
                  <div className="text-sm font-medium text-fg">Compact density</div>
                  <div className="text-xs text-fg-muted">Switch row with title and description.</div>
                </div>
                <Switch
                  checked={density === 'compact'}
                  onCheckedChange={(next) => {
                    setDensity(next ? 'compact' : 'comfortable');
                    setAxis('data-density', next ? 'compact' : 'comfortable');
                  }}
                />
              </div>
              <Demo className="!flex-col !items-stretch">
                <Skeleton className="h-4 w-2/3" />
                <Skeleton className="h-4 w-1/2" />
              </Demo>
            </div>
          </div>
        </Section>

        <Section
          id="badges"
          title="Badges &amp; status"
          description="The vocabulary string picks the tone, so a published version is the same green on every screen."
        >
          <Demo>
            {['draft', 'review', 'published', 'deprecated', 'sunset'].map((status) => (
              <Badge key={status} status={status} dot>
                {status}
              </Badge>
            ))}
            <Badge status="archived">Archived</Badge>
            <Badge status="private">Private</Badge>
            <Badge status="new">New</Badge>
          </Demo>
          <Demo>
            <Badge status="healthy">Healthy</Badge>
            <Badge status="degraded">Degraded</Badge>
            <Badge status="down">Down</Badge>
            <Badge status="unknown">Unknown</Badge>
            <Badge status="completed">Completed</Badge>
            <Badge status="failed">Failed</Badge>
            <Badge variant="ink">Ink</Badge>
            <Badge variant="outline">Outline</Badge>
            <Badge mono square>
              ver_2f81
            </Badge>
            <Badge variant="ok" size="lg">
              Large
            </Badge>
          </Demo>
        </Section>

        <Section
          id="status-vocabulary"
          title="Status vocabulary"
          description="One mapping from the app's own enum strings to a tone (DESIGN.md §3.1). A state follows the theme; a format or an HTTP verb does not, because that hue is an identity."
        >
          {VOCABULARIES.map((vocabulary) => (
            <div key={vocabulary.title} className="flex flex-col gap-1.5">
              <div className="text-2xs font-semibold uppercase tracking-[0.06em] text-fg-muted">
                {vocabulary.title}
              </div>
              <Demo>
                {vocabulary.values.map((value) => (
                  <Badge key={value} status={value} dot>
                    {value}
                  </Badge>
                ))}
              </Demo>
            </div>
          ))}

          <div className="flex flex-col gap-1.5">
            <div className="text-2xs font-semibold uppercase tracking-[0.06em] text-fg-muted">
              Formats — fixed hues
            </div>
            <Demo>
              {GALLERY_FORMATS.map((format) => (
                <FormatPill key={format} format={format} />
              ))}
            </Demo>
          </div>

          <div className="flex flex-col gap-1.5">
            <div className="text-2xs font-semibold uppercase tracking-[0.06em] text-fg-muted">
              HTTP methods — fixed hues
            </div>
            <Demo>
              {HTTP_METHODS.map((method) => (
                <MethodChip key={method} method={method} />
              ))}
            </Demo>
          </div>

          <div className="flex flex-col gap-1.5">
            <div className="text-2xs font-semibold uppercase tracking-[0.06em] text-fg-muted">
              The pills that share the vocabulary
            </div>
            <Demo>
              <HealthPill status="healthy" />
              <HealthPill status="degraded" />
              <HealthPill status="unreachable" />
              <HealthPill status="unknown" />
              <FreshnessPill freshness="stale" />
              <FreshnessPill freshness="quarantined" />
              <RecencyPill timestamp={GALLERY_TIMESTAMP} nowMs={GALLERY_NOW_MS} />
            </Demo>
            <Demo>
              {GRADE_LETTERS.map((letter) => (
                <GradeChip key={letter} grade={letter} />
              ))}
              <GradeChip grade={null} />
              <GradeGlyph grade="A" score={94} size="sm" />
              <GradeGlyph grade="C" score={71} size="sm" />
              <GradeGlyph grade={null} size="sm" />
            </Demo>
          </div>
        </Section>

        <Section
          id="cards"
          title="Cards"
          description="A card is a surface, not a box: default lifts, flat draws a hairline, soft drops both."
        >
          <div className="grid gap-4 md:grid-cols-3">
            <Card>
              <CardHeader>
                <CardTitle>Card with header</CardTitle>
                <CardDescription>The default: surface plus one step of elevation.</CardDescription>
              </CardHeader>
              <CardContent className="text-sm text-fg-muted">Body content.</CardContent>
              <CardFooter>
                <span>Footer</span>
                <Button variant="link">Action</Button>
              </CardFooter>
            </Card>
            <Card variant="flat" hover>
              <CardContent className="flex flex-col items-start gap-2">
                <Badge status="draft" dot>
                  Draft
                </Badge>
                <div className="text-base font-semibold text-fg">Hover card</div>
                <div className="mono text-xs text-fg-subtle">v2.4.0 · 18 paths</div>
              </CardContent>
            </Card>
            <Card variant="honey">
              <CardContent className="flex flex-col gap-1">
                <div className="text-base font-semibold text-fg">Honey card</div>
                <div className="text-xs text-fg-muted">Brand moments: checklists, tips.</div>
              </CardContent>
            </Card>
          </div>
        </Section>

        <Section
          id="tabs"
          title="Tabs"
          description="Underline by default, with count pills; pills and vertical are the two other shapes."
        >
          <Tabs defaultValue="overview">
            <TabsList>
              <TabsTrigger value="overview">Overview</TabsTrigger>
              <TabsTrigger value="versions">
                Versions <TabsCount>6</TabsCount>
              </TabsTrigger>
              <TabsTrigger value="lint">
                Lint <TabsCount>2</TabsCount>
              </TabsTrigger>
              <TabsTrigger value="settings" disabled>
                Settings
              </TabsTrigger>
            </TabsList>
            <TabsContent value="overview" className="text-sm text-fg-muted">
              The selected tab inks its underline and label in <code className="mono">--fg</code>.
            </TabsContent>
            <TabsContent value="versions" className="text-sm text-fg-muted">
              Six versions.
            </TabsContent>
            <TabsContent value="lint" className="text-sm text-fg-muted">
              Two findings.
            </TabsContent>
          </Tabs>
          <Tabs defaultValue="queue">
            <TabsList variant="pills">
              <TabsTrigger variant="pills" value="queue">
                Queue
              </TabsTrigger>
              <TabsTrigger variant="pills" value="trends">
                Trends
              </TabsTrigger>
              <TabsTrigger variant="pills" value="ranks">
                Quality ranks
              </TabsTrigger>
            </TabsList>
          </Tabs>
        </Section>

        <Section
          id="segmented"
          title="Segmented"
          description="A view switch, not a tab strip: the same content drawn a different way. Radiogroup semantics, arrow-key navigable, selection follows focus."
        >
          <Demo>
            <Segmented value={view} onValueChange={setView} aria-label="View">
              <SegmentedItem value="cards">
                <LayoutGrid aria-hidden />
                Cards
              </SegmentedItem>
              <SegmentedItem value="table">
                <List aria-hidden />
                Table
              </SegmentedItem>
            </Segmented>
            <Segmented size="sm" value={scope} onValueChange={setScope} aria-label="Scope">
              <SegmentedItem value="mine">Mine</SegmentedItem>
              <SegmentedItem value="workspace">Workspace</SegmentedItem>
              <SegmentedItem value="archived" disabled>
                Archived
              </SegmentedItem>
            </Segmented>
            <Segmented
              value={density}
              onValueChange={(next) => {
                setDensity(next);
                setAxis('data-density', next);
              }}
              aria-label="Density"
            >
              <SegmentedItem value="comfortable">Comfortable</SegmentedItem>
              <SegmentedItem value="compact">Compact</SegmentedItem>
            </Segmented>
          </Demo>
          <Demo>
            <span className="text-sm text-fg-muted">Shortcut chips:</span>
            <Kbd>N</Kbd>
            <Kbd keys={['⌘', 'K']} />
            <Kbd keys={['⌘', '⇧', 'P']} />
            {/* `--fg-subtle` is a large-text/non-text token (see the legibility case in
                `tests/hive-design-tokens.test.ts`); a 12 px caption uses `--fg-muted`. */}
            <span className="text-xs text-fg-muted">
              All four disappear when &ldquo;Show keyboard hints&rdquo; is off.
            </span>
          </Demo>
        </Section>

        <Section
          id="avatars"
          title="Avatars"
          description="People are circles, workspaces are hexagons. The tint is hashed from the id, so one person is one colour everywhere."
        >
          <Demo>
            <Avatar size="xs" name="Ada Lovelace" seed="user_ada" />
            <Avatar size="sm" name="Grace Hopper" seed="user_grace" />
            <Avatar name="Linus Torvalds" seed="user_linus" />
            <Avatar size="lg" name="Margaret Hamilton" seed="user_margaret" />
            <Avatar size="xl" name="Alan Turing" seed="user_alan" />
            <Avatar size="lg" shape="hex" tone="brand" name="Acme Corp" />
            <Avatar shape="hex" tone="honey" name="Guild" />
            <AvatarStack>
              <Avatar size="sm" name="Ada Lovelace" seed="user_ada" />
              <Avatar size="sm" name="Grace Hopper" seed="user_grace" />
              <Avatar size="sm" name="Linus Torvalds" seed="user_linus" />
              <Avatar size="sm" tone="neutral">
                +4
              </Avatar>
            </AvatarStack>
          </Demo>
        </Section>

        <Section
          id="tables"
          title="Tables"
          description="Sticky caps header, hover-revealed row actions, selection with a sticky bulk bar, foot with count and paging. Skeleton rows while loading, the empty state inside the card."
        >
          <TablesShowcase />
        </Section>

        <Section
          id="overlays"
          title="Overlays &amp; banners"
          description="A 20 px-radius surface on a tinted scrim, at one of five widths; the drawer is the same behaviour as a right-hand sheet; banners tint by severity."
        >
          <Demo>
            <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
              <DialogTrigger asChild>
                <Button variant="primary">Open dialog</Button>
              </DialogTrigger>
              <DialogContent>
                <DialogHeader>
                  <DialogTitle>Publish version 2.4.0</DialogTitle>
                  <DialogDescription>
                    Consumers will see the new contract as soon as this is published.
                  </DialogDescription>
                </DialogHeader>
                <FormField label="Release note">
                  <Textarea placeholder="What changed?" />
                </FormField>
                <DialogFooter>
                  <Button variant="outline" onClick={() => setDialogOpen(false)}>
                    Cancel
                  </Button>
                  <Button variant="primary" onClick={() => setDialogOpen(false)}>
                    Publish
                  </Button>
                </DialogFooter>
              </DialogContent>
            </Dialog>
            <Drawer open={drawerOpen} onOpenChange={setDrawerOpen}>
              <DrawerTrigger asChild>
                <Button variant="outline">Open drawer</Button>
              </DrawerTrigger>
              <DrawerContent>
                <DrawerHeader>
                  <DrawerTitle>Audit event</DrawerTitle>
                  <DrawerDescription className="mono">
                    evt_9c1d · Aug 15, 09:12:44
                  </DrawerDescription>
                </DrawerHeader>
                <DrawerBody className="flex flex-col gap-3 text-sm text-fg">
                  <div className="flex justify-between gap-4">
                    <span className="text-fg-muted">Actor</span>
                    <span className="flex items-center gap-2">
                      <Avatar size="xs" name="Ada Lovelace" seed="user_ada" />
                      Ada Lovelace
                    </span>
                  </div>
                  <div className="flex justify-between gap-4">
                    <span className="text-fg-muted">Action</span>
                    <Badge status="active">role.assign</Badge>
                  </div>
                  <div className="flex justify-between gap-4">
                    <span className="text-fg-muted">Target</span>
                    <span>Grace Hopper → Admin</span>
                  </div>
                  <p className="text-xs text-fg-muted">
                    The list behind the sheet keeps its scroll position and its filters —
                    that is the whole argument for a drawer.
                  </p>
                </DrawerBody>
                <DrawerFooter>
                  <DrawerOpenFullPageLink href="#overlays" />
                  <DrawerClose asChild>
                    <Button variant="outline">Close</Button>
                  </DrawerClose>
                  <Button variant="primary" onClick={() => setDrawerOpen(false)}>
                    Edit roles
                  </Button>
                </DrawerFooter>
              </DrawerContent>
            </Drawer>
          </Demo>
          <div className="flex flex-col gap-2">
            {(['info', 'ok', 'warn', 'danger', 'honey', 'neutral'] as const).map((tone) => (
              <Alert
                key={tone}
                variant={tone}
                actions={
                  <Button size="sm" variant="ghost">
                    Retry
                  </Button>
                }
              >
                <AlertTitle>Banner — {tone}</AlertTitle>
                <AlertDescription>
                  What happened, and what to do about it, in one sentence.
                </AlertDescription>
              </Alert>
            ))}
          </div>
        </Section>

        <Section
          id="feedback"
          title="Feedback: empty, gated, error, loading"
          description="Honeycomb art, a title that names the situation, a description that teaches the way out, and at most two actions. Errors add a retry; loading holds the shape of what is coming."
        >
          <Demo>
            <EmptyState
              className="w-full"
              icon={<FolderOpen />}
              title="No projects yet"
              description="Create one from a template, or import an existing spec."
              action={
                <Button variant="primary">
                  <Plus aria-hidden />
                  New project
                </Button>
              }
              secondaryAction={
                <Button variant="outline">
                  <Upload aria-hidden />
                  Import
                </Button>
              }
            />
          </Demo>

          <Demo>
            <div className="grid w-full gap-3 md:grid-cols-2">
              <Card variant="flat">
                <GatedState variant="inline" description="API keys are scoped to one workspace." />
              </Card>
              <Card variant="flat">
                <EmptyState
                  variant="inline"
                  dashed
                  tone="neutral"
                  icon={<SearchX />}
                  title="No projects match your filters"
                  description="Try clearing the search, or the “Needs attention” chip."
                />
              </Card>
              <Card variant="flat">
                <ErrorState
                  variant="inline"
                  title="Catalog analytics unavailable"
                  description="The insight service returned 503 — try again in a moment."
                  onRetry={() => undefined}
                />
              </Card>
              <Card variant="flat">
                <EmptyState
                  variant="inline"
                  brand
                  title="Welcome to Apiome"
                  description="Pick a starting point and the workspace fills itself in."
                />
              </Card>
            </div>
          </Demo>

          <ErrorBanner
            title="Couldn’t load projects."
            description="The API returned 502."
            onRetry={() => undefined}
          />

          <Demo>
            <div className="grid w-full gap-4 md:grid-cols-2">
              <div className="flex flex-col gap-3">
                <p className="text-xs font-semibold tracking-[var(--track-caps)] uppercase text-fg-muted">
                  Skeleton — shaped like the content
                </p>
                <SkeletonCard />
                <SkeletonText lines={3} />
              </div>
              <div className="flex flex-col gap-3">
                <p className="text-xs font-semibold tracking-[var(--track-caps)] uppercase text-fg-muted">
                  Spinner — only when the result has no shape
                </p>
                <LoadingState
                  message="Publishing version 2.4.0…"
                  minHeightClassName="min-h-40"
                  className="rounded-md bg-surface"
                />
              </div>
            </div>
          </Demo>
        </Section>

        <Section
          id="metrics"
          title="Metrics: stat, ring, sparkline, meter, progress"
          description="Inline SVG and tokens — no charting dependency. A caller passes a number; the kit picks the band. Rings colour ≥90 ok · 75–89 accent · 60–74 warn · <60 danger; a quota meter warns at 80% and turns danger at its cap."
        >
          <StatGrid columns={4}>
            <Stat
              label="Projects"
              icon={<FolderOpen />}
              value={128}
              delta={12}
              footnote="vs last week"
            />
            <Stat
              label="Published versions"
              icon={<UploadCloud />}
              value="1,204"
              delta={0}
              footnote="no change"
            />
            <Stat
              label="Open findings"
              icon={<Filter />}
              value={37}
              delta={9}
              deltaPolarity="negative"
              footnote="since Monday"
            />
            <Stat
              label="Mean quality"
              icon={<Sparkles />}
              value={84}
              unit="/ 100"
              delta={3}
              footnote="30-day mean"
              footnoteEnd="Grade B"
            />
          </StatGrid>

          <Demo>
            {RING_SPECIMENS.map((specimen) => (
              <div key={specimen.band} className="flex flex-col items-center gap-1.5">
                <Ring score={specimen.score} label={specimen.label} />
                <span className="text-2xs font-medium tracking-[var(--track-caps)] uppercase text-fg-muted">
                  {specimen.band}
                </span>
              </div>
            ))}
            <div className="flex flex-col items-center gap-1.5">
              <Ring score={84} label="Lint grade" display="grade" size="lg" />
              <span className="text-2xs font-medium tracking-[var(--track-caps)] uppercase text-fg-muted">
                Grade, lg
              </span>
            </div>
            <div className="flex flex-col items-center gap-1.5">
              <Ring score={91} label="Quality score" size="sm" />
              <span className="text-2xs font-medium tracking-[var(--track-caps)] uppercase text-fg-muted">
                Small
              </span>
            </div>
          </Demo>

          <Demo className="!grid grid-cols-1 gap-4 md:grid-cols-2">
            <Sparkline
              data={[4, 6, 5, 9, 8, 12, 11, 15, 14, 18]}
              label="Mock requests, last 30 days"
              tone="ok"
            />
            <Sparkline
              data={[22, 19, 20, 14, 16, 11, 12, 8, 9, 5]}
              label="Open findings, last 30 days"
              tone="danger"
            />
          </Demo>

          <Demo className="!flex-col !items-stretch gap-3">
            <Meter label="Member seats" value={3} max={10} showLabel />
            <Meter label="Monthly mock calls" value={82} max={100} showLabel />
            <Meter label="Storage" value={100} max={100} showLabel />
            <Meter label="Documentation score" value={60} tone="warn" showLabel thin />
          </Demo>

          <Demo className="!flex-col !items-stretch gap-3">
            <Progress value={64} label="Importing operations" />
            <Progress value={38} label="Exporting bundle" tone="honey" striped />
            <Progress value={100} label="Publish complete" tone="ok" thin />
          </Demo>
        </Section>
      </main>
    </TooltipProvider>
  );
}
