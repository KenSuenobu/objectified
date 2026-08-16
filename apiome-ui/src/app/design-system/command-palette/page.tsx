'use client';

/**
 * Command palette — live showcase gallery (HIVE-3.6, #5292).
 *
 * The production counterpart of `docs/mockups/DESIGN.md` §5.4: a data-free route at
 * `/design-system/command-palette` that opens the real palette, over the real stylesheet,
 * with no session and no database behind it.
 *
 * It exists because three of this ticket's acceptance criteria are questions a jsdom render
 * cannot answer — jsdom compiles no CSS, paints nothing and runs no axe:
 *
 *   • **"Arrow keys move a *visible* active row."** Visible means a background that changes,
 *     which is `[data-selected]` in the stylesheet rather than anything React renders.
 *   • **"Announced as a dialog; results list is an ARIA listbox."** Worth checking with axe
 *     on a composited tree rather than by reading attributes back out of a render.
 *   • **"Works in all nine themes, both densities and all six font scales"** (roadmap §6) —
 *     the shared switchers above do that, and `e2e/hive-command-palette.spec.ts` drives them.
 *
 * The palette here is the real component with a hand-built session: `buildCommandGroups()`
 * from the navigation model, once with a workspace and once without, so the gated Actions
 * of the third acceptance criterion are visible side by side with the ungated ones.
 *
 * Sibling galleries: `/design-system/hive` (the primitives), `/design-system/page-header`.
 */

import * as React from 'react';
import { Badge, Button, TooltipProvider } from '@/app/components/ui';
import { CommandPalette, RailSearchTrigger } from '@/app/components/shell';
import { registerCommandPaletteHost } from '@/app/components/shell/commandPaletteBus';
import {
  buildCommandGroups,
  parseCommandQuery,
  type PaletteCommand,
} from '@/app/components/shell/commandPaletteModel';
import type { CommandPaletteRecent } from '@/app/components/shell/commandPaletteRecents';
import { getPlatformNavGroups } from '@lib/platform-nav';
import PreferenceAxes from '../PreferenceAxes';

/** The workspace the "signed in" specimen pretends to be in. */
const DEMO_TENANT_ID = 'gallery-workspace';

/**
 * Recent rows, as a workspace that has been used for a while would have.
 *
 * Real shapes rather than lorem: a project and a version, which is what
 * `docs/mockups/assets/hive.js` puts in the group and what the page epics will record.
 */
const DEMO_RECENTS: readonly CommandPaletteRecent[] = [
  {
    id: 'demo-payments',
    label: 'Payments API',
    href: '/design-system/command-palette',
    meta: 'v2.4.0 · draft',
    icon: 'file-json-2',
    at: 2,
  },
  {
    id: 'demo-orders',
    label: 'Orders Service',
    href: '/design-system/command-palette',
    meta: 'v1.9.2 · published',
    icon: 'file-json-2',
    at: 1,
  },
];

/** Props for {@link Specimen}. */
interface SpecimenProps {
  /** `data-testid` of the card, which the e2e suite clicks. */
  id: string;
  /** What this specimen is for. */
  title: string;
  /** Why it is here — the rule or the acceptance criterion it demonstrates. */
  note: string;
  /** The control that opens it. */
  children: React.ReactNode;
}

/**
 * One captioned specimen.
 *
 * @param props See {@link SpecimenProps}.
 * @returns The card.
 */
function Specimen({ id, title, note, children }: SpecimenProps) {
  return (
    <section data-testid={id} className="flex flex-col gap-3">
      <div>
        <h2 className="text-sm font-semibold text-fg">{title}</h2>
        <p className="max-w-[72ch] text-xs text-fg-muted">{note}</p>
      </div>
      {children}
    </section>
  );
}

/**
 * The gallery.
 *
 * @returns The two specimens, the rail trigger and the palette they open.
 */
export default function CommandPaletteGalleryPage() {
  const [open, setOpen] = React.useState(false);
  const [query, setQuery] = React.useState('');
  const [tenantId, setTenantId] = React.useState<string | null>(DEMO_TENANT_ID);
  /** The last row chosen, printed instead of navigating — this route goes nowhere. */
  const [chosen, setChosen] = React.useState<string | null>(null);

  const { commandsOnly } = parseCommandQuery(query);

  const groups = React.useMemo(
    () =>
      buildCommandGroups({
        navGroups: getPlatformNavGroups({ currentTenantId: tenantId }),
        recents: tenantId ? DEMO_RECENTS : [],
        currentTenantId: tenantId,
        commandsOnly,
      }),
    [tenantId, commandsOnly]
  );

  /**
   * Open the palette with something already typed.
   *
   * @param initial What to prefill the search with.
   */
  const openWith = React.useCallback((initial: string) => {
    setChosen(null);
    setQuery(initial);
    setOpen(true);
  }, []);

  // Register as the palette host for this route, so `RailSearchTrigger` — which renders
  // nothing unless a host exists — is the real component rather than a mock-up of one.
  React.useEffect(
    () => registerCommandPaletteHost((request) => openWith(request?.query ?? '')),
    [openWith]
  );

  const handleSelect = React.useCallback((command: PaletteCommand) => {
    setOpen(false);
    setChosen(command.label);
  }, []);

  return (
    <TooltipProvider>
      <main className="mx-auto flex max-w-[75rem] flex-col gap-8 p-[var(--page-pad)]">
        <header className="flex flex-col gap-3">
          <h1 className="text-3xl font-semibold tracking-[-0.02em] text-fg">
            Command palette{' '}
            <Badge variant="honey" size="lg">
              HIVE-3.6
            </Badge>
          </h1>
          <p className="max-w-[72ch] text-sm text-fg-muted">
            The 640 px palette of <code className="mono">docs/mockups/DESIGN.md</code> §5.4 —
            groups <em>Jump to · Actions · Recent</em>, typeahead over title and section, and{' '}
            <code className="mono">&gt;</code> for commands only. Press{' '}
            <code className="mono">⌘K</code> anywhere in the app; here, use the controls
            below.
          </p>
          <PreferenceAxes />
        </header>

        <Specimen
          id="specimen-open"
          title="The palette, in a workspace"
          note="Recent first, then every destination the navigation model describes, then the actions. Arrows move the active row, ↵ opens it, tab switches to the Actions group, Esc closes and gives focus back to the button that opened it."
        >
          <div className="flex flex-wrap items-center gap-2">
            <Button
              variant="primary"
              data-testid="open-palette"
              onClick={() => {
                setTenantId(DEMO_TENANT_ID);
                openWith('');
              }}
            >
              Open the palette
            </Button>
            <Button
              variant="outline"
              data-testid="open-palette-commands"
              onClick={() => {
                setTenantId(DEMO_TENANT_ID);
                openWith('>');
              }}
            >
              Open on commands (&gt;)
            </Button>
          </div>
        </Specimen>

        <Specimen
          id="specimen-gated"
          title="With no workspace selected"
          note="Every workspace-scoped destination and action stays in the list and says why it cannot be used, in the same sentence the rail's tooltip uses. Hiding them would make the palette look broken to the reader who searched for one."
        >
          <Button
            variant="outline"
            data-testid="open-palette-gated"
            onClick={() => {
              setTenantId(null);
              openWith('');
            }}
          >
            Open with no workspace
          </Button>
        </Specimen>

        <Specimen
          id="specimen-trigger"
          title="The rail's search trigger"
          note="AppShell region 3 (DESIGN.md §5.2): a field-shaped button with the ⌘K chip, shown here at the rail's width. It renders nothing at all when no palette is mounted, which is how the admin console's rail gets no search."
        >
          <div className="w-[16.5rem] rounded-lg border border-border bg-rail p-3">
            <RailSearchTrigger iconRail={false} />
          </div>
        </Specimen>

        <p className="text-sm text-fg-muted" data-testid="palette-choice">
          {chosen ? `Last chosen: ${chosen}` : 'Nothing chosen yet.'}
        </p>

        <CommandPalette
          open={open}
          onOpenChange={setOpen}
          groups={groups}
          query={query}
          onQueryChange={setQuery}
          onSelect={handleSelect}
        />
      </main>
    </TooltipProvider>
  );
}
