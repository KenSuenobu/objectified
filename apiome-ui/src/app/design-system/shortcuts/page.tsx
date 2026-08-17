'use client';

/**
 * Keyboard shortcuts — live showcase gallery (HIVE-3.7, #5293).
 *
 * The production counterpart of `docs/mockups/assets/hive.js` §`#shortcuts`: a data-free
 * route at `/design-system/shortcuts` that opens the real sheet, over the real stylesheet,
 * with no session and no database behind it.
 *
 * It exists because three of this ticket's criteria are questions a jsdom render cannot
 * answer — jsdom compiles no CSS, paints nothing and runs no axe:
 *
 *   • **"The sheet is generated."** Visible here rather than argued: the switches below add
 *     and remove *registrations*, and the sheet gains and loses sections with them.
 *   • **Two columns that become one.** The grid is `auto-fit` over a `rem` measure, so the
 *     column count follows the font-size and density preferences — which the axes above
 *     drive, and `e2e/hive-shortcut-sheet.spec.ts` measures.
 *   • **"Works in all nine themes, both densities and all six font scales"** (roadmap §6),
 *     with no horizontal document scroll and no axe violations.
 *
 * Sibling galleries: `/design-system/hive` (the primitives), `/design-system/page-header`,
 * `/design-system/command-palette`.
 */

import * as React from 'react';
import { Badge, Button, Switch } from '@/app/components/ui';
import { ShortcutSheet } from '@/app/components/shell';
import { platformNavGatedReason } from '@lib/platform-nav';
import {
  CLOSE_OVERLAY_SHORTCUT,
  DATA_TABLE_SHORTCUTS,
  JUMP_SHORTCUTS,
  PALETTE_SHORTCUT,
  PREFERENCES_SHORTCUT,
  RAIL_SHORTCUT,
  SEARCH_SHORTCUT,
  SHORTCUT_SHEET_SHORTCUT,
  type ShortcutBinding,
} from '@lib/shortcuts';
import { useShortcuts } from '@/app/hooks/useShortcuts';
import PreferenceAxes from '../PreferenceAxes';

/** The workspace the "signed in" specimen pretends to be in. */
const DEMO_TENANT_ID = 'gallery-workspace';

/** Props for {@link Specimen}. */
interface SpecimenProps {
  /** `data-testid` of the card, which the e2e suite drives. */
  id: string;
  /** What this specimen is for. */
  title: string;
  /** Why it is here — the rule or the acceptance criterion it demonstrates. */
  note: string;
  /** The control that changes it. */
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
 * @returns The specimens and the sheet they register into.
 */
export default function ShortcutsGalleryPage() {
  const [open, setOpen] = React.useState(false);
  const [inWorkspace, setInWorkspace] = React.useState(true);
  const [onAList, setOnAList] = React.useState(true);
  /** The last row run, printed instead of navigating — this route goes nowhere. */
  const [chosen, setChosen] = React.useState<string | null>(null);

  const tenantId = inWorkspace ? DEMO_TENANT_ID : null;

  /**
   * What the shell would be registering on the screen these switches describe.
   *
   * Every entry is the *same declaration* the real host registers; only the handlers are the
   * gallery's, because this route has nowhere to navigate to.
   */
  const bindings = React.useMemo<readonly ShortcutBinding[]>(() => {
    const shell: ShortcutBinding[] = [
      { ...PALETTE_SHORTCUT, run: () => setChosen('Open the command palette') },
      { ...PREFERENCES_SHORTCUT, run: () => setChosen('Open preferences') },
      { ...RAIL_SHORTCUT, run: () => setChosen('Collapse or expand the sidebar') },
      { ...SEARCH_SHORTCUT, run: () => setChosen('Search or filter') },
      CLOSE_OVERLAY_SHORTCUT,
      { ...SHORTCUT_SHEET_SHORTCUT, run: () => setOpen(true) },
      ...JUMP_SHORTCUTS.map((jump) => ({
        ...jump,
        disabledReason: tenantId ? undefined : platformNavGatedReason(jump.description),
        run: () => setChosen(`Jump to ${jump.description}`),
      })),
    ];

    return onAList ? [...shell, ...DATA_TABLE_SHORTCUTS] : shell;
  }, [tenantId, onAList]);

  useShortcuts(bindings);

  return (
    <main className="mx-auto flex max-w-[75rem] flex-col gap-8 p-[var(--page-pad)]">
      <header className="flex flex-col gap-3">
        <h1 className="text-3xl font-semibold tracking-[-0.02em] text-fg">
          Keyboard shortcuts{' '}
          <Badge variant="honey" size="lg">
            HIVE-3.7
          </Badge>
        </h1>
        <p className="max-w-[72ch] text-sm text-fg-muted">
          One registry and one sheet, per <code className="mono">docs/mockups/DESIGN.md</code>{' '}
          §8. Nothing in the sheet is written down: every row is a binding some component is
          answering right now, so the reference cannot promise a chord that does not work.
          Press <code className="mono">?</code> anywhere outside a text field.
        </p>
        <PreferenceAxes />
      </header>

      <Specimen
        id="specimen-sheet"
        title="The sheet"
        note="Sections in reading order — Global, Jump, On a list — each generated from what is registered. Esc closes it and gives focus back to the button that opened it."
      >
        <Button variant="primary" data-testid="open-shortcut-sheet" onClick={() => setOpen(true)}>
          Open the shortcuts sheet
        </Button>
      </Specimen>

      <Specimen
        id="specimen-registry"
        title="Generated, not hand-written"
        note="These switches change what is registered, not what the sheet prints. Turn the list off and the row keys a table owns leave the sheet; leave the workspace and every workspace-scoped jump keeps its row and states why it cannot be used."
      >
        <div className="flex flex-wrap items-center gap-6">
          {/* The handle is `sr-only` and its visible track sits on top of it, so the
              `data-testid` rides the label — which is what a reader clicks too. */}
          <label
            className="flex items-center gap-2 text-sm text-fg"
            data-testid="toggle-list"
          >
            <Switch checked={onAList} onCheckedChange={setOnAList} />A table is on screen
          </label>
          <label
            className="flex items-center gap-2 text-sm text-fg"
            data-testid="toggle-workspace"
          >
            <Switch checked={inWorkspace} onCheckedChange={setInWorkspace} />A workspace is
            selected
          </label>
        </div>
      </Specimen>

      <p className="text-sm text-fg-muted" data-testid="shortcut-choice">
        {chosen ? `Last run: ${chosen}` : 'Nothing run yet.'}
      </p>

      <ShortcutSheet open={open} onOpenChange={setOpen} />
    </main>
  );
}
