/**
 * The stylesheet half of the primitive re-token (HIVE-2.1, #5280).
 *
 * `tests/hive-primitives.test.tsx` proves each component renders the right *tokens*. This
 * suite proves the two things a component test cannot see:
 *
 *   1. **the sweep is complete and stays complete.** A primitive that names a Tailwind
 *      palette colour (`bg-gray-800`, `dark:border-slate-600`) cannot follow a theme swap —
 *      that is the problem statement of the ticket. So the swept files are scanned as they
 *      stand, and the handful deliberately left for a later ticket are listed by name with
 *      the ticket that owns them. A palette class coming back to a swept file fails here,
 *      in the ordinary `yarn test` gate, rather than at review time.
 *   2. **the CSS the primitives lean on is actually there** — the control chrome, the 3 px
 *      azure focus ring, and the absence of the unlayered `font: inherit` that used to
 *      swallow every type utility on a control.
 *
 * Companion to `tests/hive-design-tokens.test.ts` (the token layer) and
 * `tests/hive-rem-audit.test.ts` (frozen sizes).
 */

import { readFileSync, readdirSync } from 'node:fs';
import { extname, join } from 'node:path';
import {
  parseBlock,
  readGlobalsCss,
  readTokenLayer,
  resolveToken,
  stripCssComments,
} from './helpers/design-tokens';

/** The primitive layer: the top-level modules of `components/ui`. */
const UI_DIR = join(__dirname, '..', 'src', 'app', 'components', 'ui');

const css = readGlobalsCss();
const layer = readTokenLayer(css);

/**
 * Primitives this ticket deliberately did **not** sweep, and who owns each.
 *
 * Listing them rather than skipping the directory is the point: the boundary is written
 * down, and a file only leaves the list by being re-tokened.
 */
const DEFERRED: Readonly<Record<string, string>> = {
  'Markdown.tsx': 'HIVE-2.x — prose styling travels with the docs surfaces',
  'markdownGithubComponents.tsx': 'HIVE-2.x — prose styling travels with the docs surfaces',
};

/**
 * A Tailwind palette utility: a named ramp plus a numeric step, in any variant position.
 *
 * `-slate-` rather than `slate` because `translate-y-px` is geometry, not colour; the
 * leading separator also keeps `text-fg-subtle` and friends out of the match.
 */
const PALETTE_CLASS =
  /\b(?:[a-z-]+:)*(?:bg|text|border|ring|shadow|fill|stroke|from|via|to|decoration|outline|divide|accent|caret|placeholder)-(?:slate|gray|zinc|neutral|stone|red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose)-\d{2,3}\b/g;

/**
 * A module's source with its comments blanked out, line numbering preserved.
 *
 * The scans below are about what a component *renders*, and these files document what they
 * replaced (`bg-indigo-600`, `dark:ring-offset-slate-900`) as part of explaining why. Prose
 * about a palette class is not a palette class.
 */
function codeOf(file: string): string {
  const source = readFileSync(join(UI_DIR, file), 'utf8');
  return source
    .replace(/\/\*[\s\S]*?\*\//g, (block) => block.replace(/[^\n]/g, ' '))
    .replace(/(^|[^:])\/\/[^\n]*/g, (line, lead) => lead + ' '.repeat(line.length - lead.length));
}

/** Every top-level `.tsx`/`.ts` module of the primitive layer. */
function primitiveModules(): string[] {
  return readdirSync(UI_DIR, { withFileTypes: true })
    .filter((entry) => entry.isFile() && ['.ts', '.tsx'].includes(extname(entry.name)))
    .map((entry) => entry.name)
    .sort();
}

/** The palette classes `file` still names, as `line: match` strings. */
function paletteClassesIn(file: string): string[] {
  const source = codeOf(file);
  const hits: string[] = [];
  source.split('\n').forEach((line, index) => {
    for (const match of line.matchAll(PALETTE_CLASS)) {
      hits.push(`${file}:${index + 1}  ${match[0]}`);
    }
  });
  return hits;
}

describe('the sweep — no primitive names a palette colour', () => {
  const swept = primitiveModules().filter((file) => !(file in DEFERRED));

  it('sweeps every primitive the ticket claims', () => {
    // The ticket's scope list, spelled out — if one of these stops being scanned (renamed,
    // moved, quietly added to DEFERRED) the sweep has a hole and this is where it shows.
    expect(swept).toEqual(
      expect.arrayContaining([
        'Alert.tsx',
        'AlertDialog.tsx',
        'Badge.tsx',
        'Button.tsx',
        'Card.tsx',
        'Checkbox.tsx',
        'Dialog.tsx',
        'FormField.tsx',
        'Input.tsx',
        'Label.tsx',
        'RadioGroup.tsx',
        'Select.tsx',
        'Skeleton.tsx',
        'Spinner.tsx',
        'Switch.tsx',
        'Tabs.tsx',
        'Textarea.tsx',
        'Tooltip.tsx',
        'tabStyles.ts',
        // HIVE-2.2 (#5281): the four new primitives, and the toast HIVE-2.1 handed to the
        // overlay family. Listed here for the same reason as the rest — a new primitive
        // that names a palette colour must fail in the ordinary test gate.
        'Avatar.tsx',
        'Drawer.tsx',
        'Kbd.tsx',
        'Segmented.tsx',
        'Toaster.tsx',
        // HIVE-2.5 (#5284): the feedback set, which HIVE-2.1 deferred because it was a
        // redesign rather than a re-token — the gradient orb and the red-tinted box had no
        // token equivalent to be pointed at.
        'EmptyState.tsx',
        'ErrorState.tsx',
        'LoadingState.tsx',
      ])
    );
  });

  it.each(primitiveModules().filter((file) => !(file in DEFERRED)))(
    '%s paints from tokens, not from the Tailwind palette',
    (file) => {
      expect(paletteClassesIn(file)).toEqual([]);
    }
  );

  it.each(primitiveModules().filter((file) => !(file in DEFERRED)))(
    '%s carries no `dark:` variant, which only knows two of the nine themes',
    (file) => {
      const hits = [...codeOf(file).matchAll(/\bdark:[a-z[]/g)].map((m) => m[0]);
      expect(hits).toEqual([]);
    }
  );

  it('names a ticket for every primitive left unswept', () => {
    const present = new Set(primitiveModules());
    for (const [file, owner] of Object.entries(DEFERRED)) {
      expect(present.has(file)).toBe(true);
      expect(owner).toMatch(/HIVE-\d/);
    }
  });
});

describe('control chrome — the CSS the form primitives lean on', () => {
  const hiveControl = css.match(/^\.hive-control[^{]*\{[^}]*\}/gm) ?? [];

  it('declares the base hairline and its hover, focus, invalid and disabled states', () => {
    const rules = css.split('\n').filter((line) => line.trimStart().startsWith('.hive-control'));
    const preludes = rules.join('\n');
    expect(hiveControl.length).toBeGreaterThan(0);
    expect(preludes).toContain('.hive-control:hover');
    expect(preludes).toContain('.hive-control:focus');
    expect(preludes).toContain(".hive-control[aria-invalid='true']");
    expect(preludes).toContain('.hive-control:disabled');
  });

  it('reads invalidity from aria-invalid, so the ring and the announcement agree', () => {
    // Anything else (a `data-invalid` of our own, a class) could be set without the
    // assistive-technology signal, and then the two disagree silently.
    expect(css).toMatch(/\.hive-control\[aria-invalid='true'\]/);
    expect(css).not.toMatch(/\.hive-control\[data-invalid/);
  });

  it('is unlayered, which is the only way it can outrank the focus ring', () => {
    // `*:focus-visible` is unlayered; an unlayered rule beats every `@layer utilities`
    // class whatever its specificity, so a `focus-visible:shadow-…` utility on the element
    // would never be seen. Both sides being unlayered is what lets specificity decide.
    const layerBlocks = [...stripCssComments(css).matchAll(/@layer\s+[^{]*\{/g)];
    expect(layerBlocks).toHaveLength(0);
    expect(css).not.toMatch(/@utility\s+hive-control/);
  });

  it('declares the five control-chrome shadows in the token layer', () => {
    for (const token of [
      '--shadow-control',
      '--shadow-control-hover',
      '--shadow-control-focus',
      '--shadow-control-invalid',
      '--shadow-control-solid',
    ]) {
      expect(layer.theme.has(token)).toBe(true);
      expect(resolveToken(token, layer)).toMatch(/\S/);
    }
  });

  it('spells the theme-sensitive shadows with :root aliases, never --color-* names', () => {
    // Tailwind resolves a `--color-*` reference inside `color-mix()` at build time, which
    // would freeze the hairline at the light palette — the same trap `--shadow-focus`
    // documents. Reading the alias keeps the value live through the per-theme swap.
    for (const token of ['--shadow-control', '--shadow-control-hover', '--shadow-control-focus']) {
      expect(layer.theme.get(token)).not.toMatch(/var\(--color-/);
    }
  });
});

describe('the focus ring', () => {
  it('is the 3 px azure token on every interactive element', () => {
    const rule = /\*:focus-visible\s*\{([^}]*)\}/.exec(css);
    expect(rule).not.toBeNull();
    expect(rule![1]).toContain('box-shadow: var(--shadow-focus)');
    expect(resolveToken('--shadow-focus', layer)).toContain('3px');
  });
});

describe('type utilities reach a control again', () => {
  it('no longer restates Tailwind preflight`s `font: inherit` outside a layer', () => {
    // The duplicate was unlayered, so it outranked `@layer utilities` and silently ate
    // `text-sm` on every button, input, select and textarea in the app.
    const rules =
      stripCssComments(css).match(/^\s*(?:input|textarea|select|button)[^{}]*\{[^}]*\}/gm) ?? [];
    const offenders = rules.filter((rule) => /font\s*:\s*inherit/.test(rule));
    expect(offenders).toEqual([]);
  });
});

describe('Radix Themes token-name collisions', () => {
  /** Every `--color-*` name `@radix-ui/themes` declares on `.radix-themes`. */
  const radixColorNames = (() => {
    const source = readFileSync(
      join(__dirname, '..', '..', 'node_modules', '@radix-ui', 'themes', 'styles.css'),
      'utf8'
    );
    return new Set([...source.matchAll(/^\s*(--color-[a-z0-9-]+)\s*:/gm)].map((m) => m[1]));
  })();

  /** The bridge block that has to restate them. */
  const bridge = parseBlock(css, 'html .radix-themes');

  it('restates every name Radix and the Hive token layer both claim', () => {
    // Not a fixed list: a Radix upgrade that adds a fourth colliding name has to fail here,
    // because the failure mode is silent — a component simply paints the wrong colour, in
    // every theme at once, and nothing else in the suite can see it.
    const collisions = [...radixColorNames].filter((name) => layer.theme.has(name)).sort();
    expect(collisions).toEqual(['--color-background', '--color-overlay', '--color-surface']);
    for (const name of collisions) {
      expect(bridge.get(name)).toMatch(/^var\(--/);
    }
  });

  it('points each collision back at the Hive token it shadowed', () => {
    expect(bridge.get('--color-surface')).toBe('var(--bg-surface)');
    expect(bridge.get('--color-overlay')).toBe('var(--bg-overlay)');
    expect(bridge.get('--color-background')).toBe('var(--bg-canvas)');
  });

  it('restates them on `.radix-themes` itself, because :root cannot reach past it', () => {
    // A custom property is inherited from the nearest *declaring ancestor*; `<Theme>` is an
    // ancestor of everything, so no amount of specificity on `:root` would win.
    const rule = /html \.radix-themes\s*\{/.test(css);
    expect(rule).toBe(true);
  });
});

describe('honey ink', () => {
  it('has a fixed foreground for the fixed brand hue, aliased like every other token', () => {
    expect(layer.theme.get('--color-honey-ink')).toMatch(/^#[0-9A-Fa-f]{6}$/);
    expect(parseBlock(css, ':root').get('--honey-ink')).toBe('var(--color-honey-ink)');
  });
});
