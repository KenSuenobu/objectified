'use client';

/**
 * Hive primitives — live showcase gallery (HIVE-2.1, #5280).
 *
 * The production counterpart of `docs/mockups/foundations/design-system.html`: a data-free
 * route at `/design-system/hive` that renders the §Buttons, §Forms, §Badges, §Cards,
 * §Tabs, §Segmented, §Avatars and §Overlays sections of the mockup with the **real**
 * `components/ui` primitives.
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
  LayoutGrid,
  List,
  Plus,
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
  FormField,
  Input,
  Kbd,
  RadioGroup,
  RadioGroupItem,
  Segmented,
  SegmentedItem,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Skeleton,
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
import { DENSITIES, FONT_SCALES } from '@/app/config/preferences';
import { SYSTEM_THEME_ID, themes } from '@/app/config/themes';

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
  };

  return (
    <TooltipProvider>
      <main className="mx-auto flex max-w-[75rem] flex-col gap-6 p-[var(--page-pad)]">
        <header className="flex flex-col gap-3">
          <h1 className="text-3xl font-semibold tracking-[-0.02em] text-fg">
            Hive primitives{' '}
            <Badge variant="honey" size="lg">
              HIVE-2.1 · 2.2
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
      </main>
    </TooltipProvider>
  );
}
